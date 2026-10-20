import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb, upsertLibrary, listLibraries } from '../core/db.ts';
import { scanLibrary, scanState } from '../core/scan.ts';
import type { DB } from '../core/db.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findAppRoot(start: string) {
  let d = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return start;
}
const APP_ROOT = process.env.AM_ROOT ? path.resolve(process.env.AM_ROOT) : findAppRoot(__dirname);
const DATA_DIR = process.env.AM_DATA ? path.resolve(process.env.AM_DATA) : path.join(APP_ROOT, 'data');
const DB_FILE = process.env.ASSETMANAGER_DB || path.join(DATA_DIR, 'library.db');
const DIST = path.join(APP_ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);

const db: DB = openDb(DB_FILE);

// ---- 文件监听：外部改动后自动重扫（防抖 2.5s） ----
const watchers = new Map<number, fs.FSWatcher>();
const watchTimers = new Map<number, NodeJS.Timeout>();

function scheduleRescan(libId: number, root: string) {
  const t = watchTimers.get(libId);
  if (t) clearTimeout(t);
  watchTimers.set(libId, setTimeout(() => {
    try { scanLibrary(db, libId, root); } catch (e) { console.error('rescan failed', e); }
  }, 2500));
}

function watchLibrary(libId: number, root: string) {
  if (watchers.has(libId)) return;
  try {
    const w = fs.watch(root, { recursive: true }, (_evt, file) => {
      if (!file) return;
      const f = String(file);
      if (f.includes('_meta') || f.startsWith('99_Temp')) return;
      scheduleRescan(libId, root);
    });
    watchers.set(libId, w);
  } catch (e) {
    console.error('watch failed', root, e);
  }
}

function unwatchLibrary(libId: number) {
  watchers.get(libId)?.close();
  watchers.delete(libId);
  const t = watchTimers.get(libId);
  if (t) clearTimeout(t);
  watchTimers.delete(libId);
}

for (const lib of db.prepare('SELECT id,root FROM libraries').all() as any[]) {
  watchLibrary(lib.id, lib.root);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.map': 'application/json'
};

function json(res: http.ServerResponse, code: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', c => s += c);
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildMtlx(name: string, cfg: any, byId: Map<number, any>) {
  const ch = cfg.channels || {};
  const fileOf = (k: string) => (ch[k]?.fileId ? byId.get(ch[k].fileId) : null);
  const base = fileOf('baseColor'), rough = fileOf('roughness'), metal = fileOf('metallic');
  const normal = fileOf('normal'), height = fileOf('height'), emis = fileOf('emissive');
  const nodes: string[] = [];
  const img = (key: string, type: string, f: any) => {
    if (!f) return;
    const fname = String(f.rel_path).split('/').pop();
    nodes.push(`  <image name="img_${key}" type="${type}">\n    <input name="file" type="filename" value="${xmlEsc(fname)}" />\n  </image>`);
  };
  img('BaseColor', 'color3', base);
  img('Roughness', 'float', rough);
  img('Metallic', 'float', metal);
  img('Emissive', 'color3', emis);
  img('Height', 'float', height);
  if (normal) {
    const fname = String(normal.rel_path).split('/').pop();
    nodes.push(`  <image name="img_Normal" type="vector3">\n    <input name="file" type="filename" value="${xmlEsc(fname)}" />\n  </image>`);
    nodes.push(`  <normalmap name="nm" type="vector3">\n    <input name="in" type="vector3" nodename="img_Normal" />\n  </normalmap>`);
  }
  const id = name.replace(/[^A-Za-z0-9_]/g, '_') || 'Material';
  const links = [
    base ? '    <input name="base_color" type="color3" nodename="img_BaseColor" />' : '',
    rough ? '    <input name="specular_roughness" type="float" nodename="img_Roughness" />' : '',
    metal ? '    <input name="metalness" type="float" nodename="img_Metallic" />' : '',
    emis ? '    <input name="emission_color" type="color3" nodename="img_Emissive" />' : '',
    normal ? '    <input name="normal" type="vector3" nodename="nm" />' : ''
  ].filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<materialx version="1.38" colorspace="lin_rec709">
${nodes.join('\n')}
  <standard_surface name="${id}" type="surfaceshader">
${links}
  </standard_surface>
  <surfacematerial name="${id}_mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="${id}" />
  </surfacematerial>
</materialx>
`;
}

const IMG_EXT_RE = /\.(png|jpe?g|tga|tif|tiff|exr|dds|webp)$/i;

function listImageFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(n => IMG_EXT_RE.test(n));
  } catch { return []; }
}

function slotOf(name: string): string | null {
  const n = name.toLowerCase();
  if (/(basecolor|base_color|albedo|diffuse|_diff|color)/.test(n)) return 'basecolor';
  if (/(normal|_nrm|nor_gl|nor_dx)/.test(n)) return 'normal';
  if (/rough/.test(n)) return 'roughness';
  if (/metal/.test(n)) return 'metallic';
  if (/(_ao|occlusion|ambient)/.test(n)) return 'ao';
  if (/(height|displacement|_disp)/.test(n)) return 'height';
  if (/(arm|orm|omr|rma)/.test(n)) return 'packed';
  return null;
}

function readMtlxRefs(file: string): string[] {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const refs = new Set<string>();
    const re = /<input[^>]*name="file"[^>]*value="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) refs.add(m[1]);
    return [...refs];
  } catch { return []; }
}

function readFbxRefs(file: string, maxBytes = 24 * 1024 * 1024): string[] {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) return [];
    const buf = fs.readFileSync(file);
    const s = buf.toString('latin1');
    const re = /([A-Za-z0-9_\- .\\/()]+\.(?:png|jpe?g|tga|tif|tiff|exr|dds))/gi;
    const refs = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const raw = m[1].split(/[\\/]/).pop();
      if (raw && raw.length < 120) refs.add(raw);
    }
    return [...refs];
  } catch { return []; }
}

function checkLibrary(lib: number) {
  const libRow = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
  if (!libRow) return { issues: [], skipped: 0 };
  const root = libRow.root;
  const assets = db.prepare('SELECT id,name,type,rel_dir,preview_rel,thumb_file FROM assets WHERE library_id=?').all(lib) as any[];
  const issues: any[] = [];
  let skipped = 0;

  for (const a of assets) {
    const dir = path.join(root, a.rel_dir);

    if (a.type === 'material') {
      const mtlx = (() => {
        try {
          return fs.readdirSync(dir).find(n => n.toLowerCase().endsWith('.mtlx'));
        } catch { return undefined; }
      })();
      if (mtlx) {
        const refs = readMtlxRefs(path.join(dir, mtlx));
        const missing = refs.filter(r => !fs.existsSync(path.join(dir, r)) && !fs.existsSync(path.join(dir, path.basename(r))));
        if (missing.length) {
          issues.push({
            assetId: a.id, name: a.name, type: a.type, kind: 'mtlx-missing',
            detail: `材质引用的 ${missing.length} 个文件不存在：${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}`,
            fix: 'rewrite-mtlx', payload: { mtlx, missing }
          });
        }
      }
    }

    if (a.type === 'model' || a.type === 'scene') {
      const fbx = (() => {
        try { return fs.readdirSync(dir).find(n => n.toLowerCase().endsWith('.fbx')); } catch { return undefined; }
      })();
      if (fbx) {
        const st = fs.statSync(path.join(dir, fbx));
        if (st.size > 24 * 1024 * 1024) { skipped++; }
        else {
          const refs = readFbxRefs(path.join(dir, fbx));
          const here = new Set(listImageFiles(dir).map(n => n.toLowerCase()));
          const mapsDir = path.join(dir, 'maps');
          const inMaps = new Set(listImageFiles(mapsDir).map(n => n.toLowerCase()));
          const missingHere = refs.filter(r => !here.has(r.toLowerCase()) && inMaps.has(r.toLowerCase()));
          if (missingHere.length) {
            issues.push({
              assetId: a.id, name: a.name, type: a.type, kind: 'copy-maps',
              detail: `${missingHere.length} 张贴图在 maps/ 里，FBX 按同级目录查找`,
              fix: 'copy-maps', payload: { files: missingHere }
            });
          }
        }
      }
    }

    if (!a.preview_rel && !a.thumb_file && ['material', 'model', 'scene'].includes(a.type)) {
      issues.push({ assetId: a.id, name: a.name, type: a.type, kind: 'missing-preview', detail: '没有预览图', fix: null });
    }
  }
  return { issues, skipped };
}

const issueCache = new Map<number, { at: number; data: any }>();
function getIssues(lib: number) {
  const hit = issueCache.get(lib);
  if (hit && Date.now() - hit.at < 30000) return hit.data;
  const data = checkLibrary(lib);
  issueCache.set(lib, { at: Date.now(), data });
  return data;
}

function ignoredSet() {
  const rows = db.prepare('SELECT asset_id, kind FROM issue_ignores').all() as any[];
  return new Set(rows.map(r => `${r.asset_id}|${r.kind}`));
}

function ghToken(): string {
  if (process.env.AM_GH_TOKEN) return process.env.AM_GH_TOKEN;
  try {
    const f = path.join(DATA_DIR, 'github-token.txt');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  } catch { /* ignore */ }
  return '';
}

function ghJson(pathname: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const token = ghToken();
    const req = https.get({
      host: 'api.github.com',
      path: pathname,
      headers: {
        'User-Agent': 'AssetManager',
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `token ${token}` } : {})
      }
    }, res => {
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const loc = String(res.headers.location).replace(/^https?:\/\/api\.github\.com/, '');
        resolve(ghJson(loc));
        return;
      }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch { reject(new Error(`GitHub 返回异常（HTTP ${res.statusCode}）`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('连接 GitHub 超时')));
  });
}

function ghDownload(url: string, dest: string, redirects = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const token = ghToken();
    const req = https.get(url, {
      headers: {
        'User-Agent': 'AssetManager',
        Accept: 'application/octet-stream',
        ...(token ? { Authorization: `token ${token}` } : {})
      }
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location && redirects < 6) {
        res.resume();
        resolve(ghDownload(String(res.headers.location), dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('下载失败：HTTP ' + res.statusCode));
        return;
      }
      const ws = fs.createWriteStream(dest);
      const fail = (msg: string) => {
        clearTimeout(idle);
        clearTimeout(hard);
        try { res.destroy(); ws.destroy(); } catch { /* ignore */ }
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        reject(new Error(msg));
      };
      let idle: any = setTimeout(() => fail('下载超时（30 秒无数据）'), 30000);
      const hard: any = setTimeout(() => fail('下载超时（超过 10 分钟）'), 600000);
      res.on('data', () => {
        clearTimeout(idle);
        idle = setTimeout(() => fail('下载超时（30 秒无数据）'), 30000);
      });
      res.pipe(ws);
      ws.on('finish', () => {
        clearTimeout(idle);
        clearTimeout(hard);
        try { resolve(fs.statSync(dest).size); } catch (e) { reject(e as any); }
      });
      ws.on('error', e => fail(String(e?.message || e)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('连接超时')));
  });
}

function fixIssue(body: any) {
  const a = db.prepare('SELECT a.*, l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.id=?').get(Number(body.assetId)) as any;
  if (!a) return { ok: false, error: 'asset not found' };
  const dir = path.join(a.root, a.rel_dir);

  if (body.fix === 'rewrite-mtlx') {
    const mtlx = String(body.payload?.mtlx || '');
    const missing: string[] = body.payload?.missing || [];
    const mtlxPath = path.join(dir, mtlx);
    if (!fs.existsSync(mtlxPath)) return { ok: false, error: 'mtlx missing' };
    const files = listImageFiles(dir);
    let text = fs.readFileSync(mtlxPath, 'utf8');
    const replaced: string[] = [];
    for (const m of missing) {
      const slot = slotOf(m);
      const cand = files.find(f => slotOf(f) === slot) || files.find(f => {
        const a1 = m.toLowerCase().split(/[_\-.]/)[0];
        return f.toLowerCase().includes(a1);
      });
      if (cand) {
        text = text.split(m).join(cand);
        replaced.push(`${m} → ${cand}`);
      }
    }
    if (!replaced.length) return { ok: false, error: '没找到可匹配的贴图' };
    const bak = mtlxPath + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(mtlxPath, bak);
    fs.writeFileSync(mtlxPath, text, 'utf8');
    return { ok: true, detail: replaced };
  }

  if (body.fix === 'copy-maps') {
    const files: string[] = body.payload?.files || [];
    const mapsDir = path.join(dir, 'maps');
    const copied: string[] = [];
    for (const f of files) {
      const src = path.join(mapsDir, f);
      const dst = path.join(dir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); copied.push(f); }
    }
    return copied.length ? { ok: true, detail: copied } : { ok: false, error: '没有需要复制的文件' };
  }

  return { ok: false, error: 'unknown fix' };
}

const TYPE_ROOT: Record<string, string> = {
  material: '02_Materials', model: '05_Models', scene: '06_Scene',
  drawing: '07_CAD', hdri: '04_HDRI', texture: '01_Texture', decal: '03_Decals'
};

function sanitizeName(n: string) {
  return n
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Asset';
}

function organizePlan(lib: number) {
  const libRow = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
  if (!libRow) return { rows: [] };
  const root = libRow.root;
  const assets = db.prepare('SELECT id,name,type,rel_dir FROM assets WHERE library_id=?').all(lib) as any[];
  const dirCount = new Map<string, number>();
  for (const a of assets) dirCount.set(a.rel_dir, (dirCount.get(a.rel_dir) || 0) + 1);

  const rows: any[] = [];
  for (const a of assets) {
    const rootName = TYPE_ROOT[a.type];
    if (!rootName) continue;
    const segs = String(a.rel_dir).split('/').filter(Boolean);
    const underType = segs[0] === rootName;
    const subPath = segs.slice(1, -1).join('/');
    const target = [rootName, subPath || 'Misc', sanitizeName(a.name)].join('/');
    const normalizedLast = sanitizeName(segs[segs.length - 1] || a.name);
    const normalizedCurrent = [...segs.slice(0, -1), normalizedLast].join('/');
    const to = underType ? normalizedCurrent : target;

    if (to === a.rel_dir) continue;

    let conflict = false;
    let skip: string | null = null;
    if ((dirCount.get(a.rel_dir) || 0) > 1) skip = '目录内含多个素材，跳过';
    if (fs.existsSync(path.join(root, to))) conflict = true;

    rows.push({
      assetId: a.id, name: a.name, type: a.type, from: a.rel_dir, to,
      conflict, skip
    });
  }
  return { rows };
}

function applyOrganize(lib: number, rows: any[]) {
  const libRow = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
  if (!libRow) return { ok: false, error: 'library not found' };
  const root = libRow.root;
  const applied: any[] = [];
  const failed: any[] = [];

  for (const r of rows) {
    if (r.skip || r.conflict) { failed.push({ ...r, error: r.skip || '目标已存在' }); continue; }
    const from = path.join(root, r.from);
    const to = path.join(root, r.to);
    try {
      if (!fs.existsSync(from)) throw new Error('源目录不存在');
      if (fs.existsSync(to)) throw new Error('目标已存在');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      applied.push({ assetId: r.assetId, from: r.from, to: r.to });
    } catch (e: any) {
      failed.push({ ...r, error: String(e?.message ?? e) });
    }
  }

  if (applied.length) {
    const dir = path.join(DATA_DIR, 'manifests');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `organize-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ root, applied, at: Date.now() }, null, 2), 'utf8');
    scanLibrary(db, lib, root);
  }
  return { ok: true, applied, failed };
}

function undoOrganize(lib: number) {
  const dir = path.join(DATA_DIR, 'manifests');
  if (!fs.existsSync(dir)) return { ok: false, error: '没有可撤销的整理记录' };
  const files = fs.readdirSync(dir).filter(f => f.startsWith('organize-')).sort();
  if (!files.length) return { ok: false, error: '没有可撤销的整理记录' };
  const file = path.join(dir, files[files.length - 1]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = data.root as string;
  const reverted: any[] = [];
  const failed: any[] = [];
  for (const r of [...data.applied].reverse()) {
    try {
      const from = path.join(root, r.to);
      const to = path.join(root, r.from);
      if (!fs.existsSync(from)) throw new Error('目录已不存在');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      reverted.push(r);
    } catch (e: any) { failed.push({ ...r, error: String(e?.message ?? e) }); }
  }
  fs.unlinkSync(file);
  const libRow = db.prepare('SELECT id FROM libraries WHERE root=?').get(root) as any;
  if (libRow) scanLibrary(db, libRow.id, root);
  return { ok: true, reverted, failed };
}

function detectTypeByName(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.mtlx') return '02_Materials';
  if (['.fbx', '.obj', '.glb', '.gltf', '.blend', '.max', '.usdz', '.stl', '.3ds', '.abc'].includes(ext)) return '05_Models';
  if (['.dwg', '.dxf'].includes(ext)) return '07_CAD';
  if (['.exr', '.hdr'].includes(ext)) return '04_HDRI';
  if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.tga', '.psd'].includes(ext)) return '01_Texture';
  return null;
}

function detectFolderType(dir: string): string {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
    const names = entries.filter(e => e.isFile()).map(e => e.name);
    if (names.some(n => n.toLowerCase().endsWith('.mtlx'))) return '02_Materials';
    if (names.some(n => /\.(fbx|obj|blend|max|glb|gltf|usdz)$/i.test(n))) return '05_Models';
    if (names.some(n => /\.(dwg|dxf)$/i.test(n))) return '07_CAD';
    if (names.some(n => /\.(exr|hdr)$/i.test(n))) return '04_HDRI';
    if (names.filter(n => IMG_EXT_RE.test(n)).length >= 2) return '01_Texture';
  } catch { /* ignore */ }
  return '_Imported';
}

function uniquePath(target: string) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 2; i < 100; i++) {
    const p = path.join(dir, `${base}_${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

function importPaths(lib: number, paths: string[]) {
  const libRow = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
  if (!libRow) return { results: [{ ok: false, from: '', error: 'library not found' }] };
  const root = libRow.root;
  const results: any[] = [];

  for (const src of paths) {
    try {
      if (!fs.existsSync(src)) throw new Error('路径不存在');
      const st = fs.statSync(src);
      const isDir = st.isDirectory();
      const name = path.basename(src.replace(/[\\/]+$/, ''));
      const typeRoot = isDir ? detectFolderType(src) : (detectTypeByName(name) || '_Imported');
      const destDir = path.join(root, typeRoot, 'Imported');
      fs.mkdirSync(destDir, { recursive: true });
      const target = uniquePath(path.join(destDir, sanitizeName(name)));
      if (isDir) fs.cpSync(src, target, { recursive: true });
      else fs.copyFileSync(src, target);
      results.push({ ok: true, from: src, to: path.relative(root, target).split(path.sep).join('/') });
    } catch (e: any) {
      results.push({ ok: false, from: src, error: String(e?.message ?? e) });
    }
  }
  if (results.some(r => r.ok)) scanLibrary(db, lib, root);
  return { results };
}

function assetQuery(url: URL) {  const lib = Number(url.searchParams.get('lib') || 0);
  const where: string[] = ['library_id = ?'];
  const params: any[] = [lib];

  const q = (url.searchParams.get('q') || '').trim();
  if (q) { where.push('(name LIKE ? OR rel_dir LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const type = url.searchParams.get('type') || 'all';
  if (type !== 'all') { where.push('type = ?'); params.push(type); }

  const dir = url.searchParams.get('dir') || '';
  if (dir) {
    if (url.searchParams.get('recursive') === '1') { where.push('rel_dir LIKE ?'); params.push(`${dir}%`); }
    else { where.push('rel_dir = ?'); params.push(dir); }
  }

  if (url.searchParams.get('minRating')) { where.push('rating >= ?'); params.push(Number(url.searchParams.get('minRating'))); }
  if (url.searchParams.get('fav') === '1') where.push('favorite = 1');
  if (url.searchParams.get('missingThumb') === '1') {
    where.push("type IN ('material','model','scene') AND preview_rel IS NULL AND thumb_file IS NULL");
  }
  const tag = Number(url.searchParams.get('tag') || 0);
  if (tag) {
    where.push('id IN (SELECT asset_id FROM asset_tags WHERE tag_id IN (SELECT id FROM tags WHERE id = ? OR parent_id = ?))');
    params.push(tag, tag);
  }
  const tagList = (url.searchParams.get('tags') || '').split(',').map(Number).filter(Boolean);
  if (tagList.length) {
    const ph = tagList.map(() => '?').join(',');
    where.push(`id IN (SELECT asset_id FROM asset_tags WHERE tag_id IN (${ph}) GROUP BY asset_id HAVING COUNT(DISTINCT tag_id) = ${tagList.length})`);
    params.push(...tagList);
  }
  const ext = url.searchParams.get('ext') || '';
  if (ext) { where.push('ext = ?'); params.push(ext); }

  const exTypes = (url.searchParams.get('excludeType') || '').split(',').filter(Boolean);
  if (exTypes.length) {
    where.push(`type NOT IN (${exTypes.map(() => '?').join(',')})`);
    params.push(...exTypes);
  }
  const exExts = (url.searchParams.get('excludeExt') || '').split(',').filter(Boolean);
  if (exExts.length) {
    where.push(`ext NOT IN (${exExts.map(() => '?').join(',')})`);
    params.push(...exExts);
  }

  const sort = url.searchParams.get('sort') || 'name';
  const order = sort === 'rating' ? 'rating DESC, name ASC'
    : sort === 'size' ? 'size DESC'
    : sort === 'mtime' ? 'updated_at DESC'
    : 'name ASC';

  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 5000);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  return { where: where.join(' AND '), params, order, limit, offset };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  if (p === '/api/update/token' && req.method === 'POST') {
    const b = await body(req);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const f = path.join(DATA_DIR, 'github-token.txt');
    if (b.token) fs.writeFileSync(f, String(b.token).trim(), 'utf8');
    else if (fs.existsSync(f)) fs.unlinkSync(f);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/update/check' && req.method === 'GET') {
    const current = (() => {
      try { return String(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0'); }
      catch { return '0.0.0'; }
    })();
    try {
      const rel = await ghJson('/repos/OMEN111111/AssetManager/releases/latest');
      if (!rel || rel.message) throw new Error(rel?.message || 'GitHub 返回空响应');
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      const cmp = (a: string, b: string) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] || 0) - (pb[i] || 0);
          if (d) return d;
        }
        return 0;
      };
      const assets = (rel.assets || []).map((a: any) => ({ id: a.id, name: a.name, size: a.size }));
      return json(res, 200, {
        current, latest, tag: String(rel.tag_name || ''), newer: cmp(latest, current) > 0,
        notes: rel.body || '', publishedAt: rel.published_at || '', assets
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const hint = /not found|404/i.test(msg)
        ? '仓库不可访问：如果是私有仓库，请在下方填写 GitHub 令牌（需 repo 权限），或把仓库设为公开'
        : msg;
      return json(res, 200, { current, error: hint });
    }
  }

  if (p === '/api/update/download' && req.method === 'POST') {
    const b = await body(req);
    const assetId = Number(b.assetId);
    const name = String(b.name || '').replace(/[\\/:*?"<>|]/g, '_');
    const tag = String(b.tag || '').replace(/[^\w.\-]/g, '');
    if (!assetId || !/\.exe$/i.test(name)) return json(res, 400, { error: 'bad asset' });
    const dir = path.join(DATA_DIR, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    const official = `https://api.github.com/repos/OMEN111111/AssetManager/releases/assets/${assetId}`;
    const mirrors = tag
      ? ['https://gh-proxy.com/', 'https://ghproxy.net/'].map(m => `${m}https://github.com/OMEN111111/AssetManager/releases/download/${tag}/${name}`)
      : [];
    const attempts = [...mirrors, official];
    const errors: string[] = [];
    for (const [i, url] of attempts.entries()) {
      try {
        const size = await ghDownload(url, dest);
        return json(res, 200, { path: dest, size, source: i < mirrors.length ? 'mirror' : 'github' });
      } catch (e: any) {
        errors.push(String(e?.message || e));
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
      }
    }
    return json(res, 500, { error: errors.join('；') || '下载失败' });
  }

  if (p === '/api/state') {
    const libs = listLibraries(db);
    const total = libs.length ? (db.prepare('SELECT COUNT(*) c FROM assets WHERE library_id=?').get((libs[0] as any).id) as any).c : 0;
    return json(res, 200, { libraries: libs, total, scan: scanState, db: DB_FILE, appRoot: APP_ROOT });
  }

  if (p === '/api/libraries' && req.method === 'POST') {
    const b = await body(req);
    if (!b.root) return json(res, 400, { error: 'root required' });
    if (!fs.existsSync(b.root)) return json(res, 400, { error: 'path not found' });
    const id = upsertLibrary(db, b.root);
    watchLibrary(id, path.resolve(b.root));
    if (!scanState.running) {
      setTimeout(() => { try { scanLibrary(db, id, path.resolve(b.root)); } catch (e) { console.error(e); } }, 10);
    }
    return json(res, 200, { id });
  }

  const mLib = p.match(/^\/api\/libraries\/(\d+)$/);
  if (mLib && req.method === 'DELETE') {
    const id = Number(mLib[1]);
    unwatchLibrary(id);
    db.prepare('DELETE FROM libraries WHERE id=?').run(id);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/scan') return json(res, 200, scanState);

  if (p === '/api/assets') {
    const { where, params, order, limit, offset } = assetQuery(url);
    const rows = db.prepare(`SELECT a.*,
      (SELECT f.id FROM files f WHERE f.asset_id = a.id
        AND (lower(f.rel_path) LIKE '%.tif' OR lower(f.rel_path) LIKE '%.tiff' OR lower(f.rel_path) LIKE '%.tga')
        LIMIT 1) AS img_file_id,
      EXISTS(SELECT 1 FROM files f2 WHERE f2.asset_id = a.id AND (
        lower(f2.rel_path) LIKE '%.png' OR lower(f2.rel_path) LIKE '%.jpg' OR lower(f2.rel_path) LIKE '%.jpeg'
        OR lower(f2.rel_path) LIKE '%.webp' OR lower(f2.rel_path) LIKE '%.gif' OR lower(f2.rel_path) LIKE '%.bmp'
        OR lower(f2.rel_path) LIKE '%.tif' OR lower(f2.rel_path) LIKE '%.tiff' OR lower(f2.rel_path) LIKE '%.tga'
      )) AS has_image
      FROM assets a WHERE ${where.replace(/\btype\b/g, 'a.type').replace(/\bext\b/g, 'a.ext')} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const total = (db.prepare(`SELECT COUNT(*) c FROM assets WHERE ${where}`).get(...params) as any).c;
    return json(res, 200, { assets: rows, total });
  }

  const mAsset = p.match(/^\/api\/asset\/(\d+)$/);
  if (mAsset && req.method === 'GET') {
    const id = Number(mAsset[1]);
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(id) as any;
    if (!a) return json(res, 404, { error: 'not found' });
    const files = db.prepare('SELECT id,rel_path,role,slot,size FROM files WHERE asset_id=? ORDER BY role DESC, rel_path').all(id);
    const tags = db.prepare('SELECT t.id,t.name,t.color,t.parent_id FROM tags t JOIN asset_tags at ON at.tag_id=t.id WHERE at.asset_id=? ORDER BY t.name').all(id);
    const lib = db.prepare('SELECT root FROM libraries WHERE id=?').get(a.library_id) as any;
    return json(res, 200, { ...a, root: lib?.root, files, tags });
  }

  if (mAsset && req.method === 'PATCH') {
    const id = Number(mAsset[1]);
    const b = await body(req);
    if (typeof b.rating === 'number') db.prepare('UPDATE assets SET rating=? WHERE id=?').run(Math.max(0, Math.min(5, b.rating | 0)), id);
    if (typeof b.favorite === 'number') db.prepare('UPDATE assets SET favorite=? WHERE id=?').run(b.favorite ? 1 : 0, id);
    if (typeof b.material === 'string') db.prepare('UPDATE assets SET material_json=? WHERE id=?').run(b.material, id);
    return json(res, 200, db.prepare('SELECT * FROM assets WHERE id=?').get(id));
  }

  if (p === '/api/mtlx' && req.method === 'POST') {
    const b = await body(req);
    const a = db.prepare('SELECT a.id,a.name,a.rel_dir,a.type,l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.id=?').get(Number(b.assetId)) as any;
    if (!a) return json(res, 404, { error: 'asset not found' });
    const files = db.prepare('SELECT id,rel_path FROM files WHERE asset_id=?').all(a.id) as any[];
    const byId = new Map(files.map(f => [f.id, f]));
    const xml = buildMtlx(a.name, b.config || {}, byId);
    const dir = path.join(a.root, a.rel_dir);
    let out = path.join(dir, `${a.name}.mtlx`);
    if (fs.existsSync(out)) out = path.join(dir, `${a.name}_assembled.mtlx`);
    fs.writeFileSync(out, xml, 'utf8');
    return json(res, 200, { path: out });
  }

  const mFile = p.match(/^\/api\/file\/(\d+)$/);
  if (mFile) {
    const f = db.prepare(`SELECT f.rel_path, l.root FROM files f
      JOIN assets a ON a.id=f.asset_id JOIN libraries l ON l.id=a.library_id WHERE f.id=?`).get(Number(mFile[1])) as any;
    if (!f) return json(res, 404, { error: 'not found' });
    const file = path.join(f.root, f.rel_path);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'missing' });
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'public, max-age=3600'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/texture/export' && req.method === 'POST') {
    const b = await body(req);
    const f = db.prepare(`SELECT f.rel_path, l.root, l.id AS lib FROM files f
      JOIN assets a ON a.id=f.asset_id JOIN libraries l ON l.id=a.library_id WHERE f.id=?`).get(Number(b.fileId)) as any;
    const m = String(b.dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
    if (!f || !m) return json(res, 400, { error: 'bad request' });
    const src = path.join(f.root, f.rel_path);
    if (!fs.existsSync(src)) return json(res, 404, { error: 'missing source' });
    const dir = path.dirname(src);
    const base = path.basename(src, path.extname(src));
    const ext = path.extname(src).toLowerCase();
    const wanted = b.name ? String(b.name).replace(/[\\/:*?"<>|]/g, '_') : '';
    const out = (b.mode === 'overwrite' && ext === '.png')
      ? src
      : path.join(dir, wanted || `${base}_edited.png`);
    fs.writeFileSync(out, Buffer.from(m[1], 'base64'));
    setTimeout(() => { try { scanLibrary(db, f.lib, f.root); } catch (e) { console.error('rescan failed', e); } }, 200);
    return json(res, 200, { path: out, overwritten: out === src });
  }

  const mThumbSave = p.match(/^\/api\/thumb\/(\d+)$/);
  if (mThumbSave && req.method === 'POST') {
    const b = await body(req);
    const m = String(b.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!m) return json(res, 400, { error: 'bad image' });
    const dir = path.join(DATA_DIR, 'thumbs');
    fs.mkdirSync(dir, { recursive: true });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const file = path.join(dir, `${mThumbSave[1]}.${ext}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    const relFile = path.relative(DATA_DIR, file).split(path.sep).join('/');
    db.prepare('UPDATE assets SET thumb_file=? WHERE id=?').run(relFile, Number(mThumbSave[1]));
    return json(res, 200, { ok: true, file });
  }

  const mThumb = p.match(/^\/api\/thumb\/(\d+)$/);
  if (mThumb) {
    const id = Number(mThumb[1]);
    const a = db.prepare('SELECT a.preview_rel, a.thumb_file, a.type, l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.id=?').get(id) as any;
    let rel = a?.preview_rel as string | null;
    if (!rel && a?.thumb_file) {
      const tf = path.isAbsolute(a.thumb_file) ? a.thumb_file : path.join(DATA_DIR, a.thumb_file);
      if (fs.existsSync(tf)) {
        const st = fs.statSync(tf);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size, 'cache-control': 'public, max-age=86400' });
        return fs.createReadStream(tf).pipe(res);
      }
    }
    if (!rel) {
      const main = db.prepare(`SELECT rel_path FROM files WHERE asset_id=?
        AND (lower(rel_path) LIKE '%.png' OR lower(rel_path) LIKE '%.jpg' OR lower(rel_path) LIKE '%.jpeg' OR lower(rel_path) LIKE '%.webp')
        ORDER BY CASE role WHEN 'main' THEN 0 WHEN 'map' THEN 1 ELSE 2 END LIMIT 1`).get(id) as any;
      if (main) rel = main.rel_path;
    }
    if (!rel) return json(res, 404, { error: 'no preview' });
    const file = path.join(a.root, rel);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'missing' });
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'public, max-age=3600'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/tags' && req.method === 'GET') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const tags = db.prepare('SELECT id,parent_id,name,color FROM tags ORDER BY name').all() as any[];
    const rows = db.prepare(`SELECT at.tag_id tid, COUNT(DISTINCT at.asset_id) c FROM asset_tags at
      JOIN assets a ON a.id=at.asset_id WHERE a.library_id=? GROUP BY at.tag_id`).all(lib) as any[];
    const own = new Map<number, number>(rows.map(r => [r.tid, r.c]));
    const byParent = new Map<number, any[]>();
    for (const t of tags) {
      const k = t.parent_id || 0;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(t);
    }
    const out: any[] = [];
    const walk = (parent: number, depth: number) => {
      for (const t of byParent.get(parent) || []) {
        const kids = byParent.get(t.id) || [];
        const count = (own.get(t.id) || 0) + kids.reduce((s, k) => s + (own.get(k.id) || 0), 0);
        out.push({ id: t.id, parentId: t.parent_id, name: t.name, color: t.color, depth, count });
        walk(t.id, depth + 1);
      }
    };
    walk(0, 0);
    return json(res, 200, { tags: out });
  }

  if (p === '/api/tags' && req.method === 'POST') {
    const b = await body(req);
    if (!b.name) return json(res, 400, { error: 'name required' });
    const info = db.prepare('INSERT INTO tags(parent_id,name,color) VALUES(?,?,?)')
      .run(b.parentId ?? null, String(b.name), b.color ?? '#8b93a1');
    return json(res, 200, db.prepare('SELECT * FROM tags WHERE id=?').get(Number(info.lastInsertRowid)));
  }

  const mTag = p.match(/^\/api\/tags\/(\d+)$/);
  if (mTag && req.method === 'PATCH') {
    const b = await body(req);
    if (b.name !== undefined) db.prepare('UPDATE tags SET name=? WHERE id=?').run(String(b.name), Number(mTag[1]));
    if (b.color !== undefined) db.prepare('UPDATE tags SET color=? WHERE id=?').run(String(b.color), Number(mTag[1]));
    if (b.parentId !== undefined) db.prepare('UPDATE tags SET parent_id=? WHERE id=?').run(b.parentId, Number(mTag[1]));
    return json(res, 200, db.prepare('SELECT * FROM tags WHERE id=?').get(Number(mTag[1])));
  }
  if (mTag && req.method === 'DELETE') {
    db.prepare('DELETE FROM tags WHERE id=?').run(Number(mTag[1]));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/tags/assign' && req.method === 'POST') {
    const b = await body(req);
    const tagId = Number(b.tagId);
    const ids: number[] = (b.assetIds || []).map(Number);
    if (!tagId || !ids.length) return json(res, 400, { error: 'tagId/assetIds required' });
    if (b.action === 'remove') {
      const st = db.prepare('DELETE FROM asset_tags WHERE asset_id=? AND tag_id=?');
      for (const id of ids) st.run(id, tagId);
    } else {
      const st = db.prepare('INSERT OR IGNORE INTO asset_tags(asset_id,tag_id) VALUES(?,?)');
      for (const id of ids) st.run(id, tagId);
    }
    return json(res, 200, { ok: true, affected: ids.length });
  }

  if (p === '/api/organize/plan') {
    return json(res, 200, organizePlan(Number(url.searchParams.get('lib') || 0)));
  }

  if (p === '/api/organize/apply' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, applyOrganize(Number(b.lib), b.rows || []));
  }

  if (p === '/api/organize/undo' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, undoOrganize(Number(b.lib)));
  }

  if (p === '/api/exts') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const rows = db.prepare('SELECT ext, type, COUNT(*) c FROM assets WHERE library_id=? GROUP BY ext, type ORDER BY c DESC').all(lib);
    return json(res, 200, { exts: rows });
  }

  if (p === '/api/reveal' && req.method === 'POST') {
    const b = await body(req);
    let full = '';
    if (b.dirPath && b.lib) {
      const lr = db.prepare('SELECT root FROM libraries WHERE id=?').get(Number(b.lib)) as any;
      if (lr) {
        const candidate = path.join(lr.root, String(b.dirPath));
        if (candidate.startsWith(lr.root)) full = candidate;
      }
    } else if (b.fileId) {
      const f = db.prepare(`SELECT f.rel_path, l.root FROM files f
        JOIN assets a ON a.id=f.asset_id JOIN libraries l ON l.id=a.library_id WHERE f.id=?`).get(Number(b.fileId)) as any;
      if (f) full = path.join(f.root, f.rel_path);
    } else {
      const a = db.prepare('SELECT a.rel_dir, l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.id=?').get(Number(b.assetId)) as any;
      if (a) full = path.join(a.root, a.rel_dir);
    }
    if (!full) return json(res, 404, { error: 'not found' });
    if (process.platform === 'win32') {
      spawn('explorer.exe', [b.fileId ? `/select,${full}` : full], { detached: true, stdio: 'ignore' }).unref();
    }
    return json(res, 200, { ok: true, path: full });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const b = await body(req);
    const lib = Number(b.lib);
    const paths: string[] = Array.isArray(b.paths) ? b.paths.filter((x: any) => typeof x === 'string' && x) : [];
    if (!paths.length) return json(res, 400, { error: '没有可导入的路径' });
    return json(res, 200, importPaths(lib, paths));
  }

  if (p === '/api/files') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const dir = url.searchParams.get('dir') || '';
    const qtxt = (url.searchParams.get('q') || '').trim();
    const where = ['a.library_id = ?'];
    const params: any[] = [lib];
    if (dir) { where.push('f.rel_path LIKE ?'); params.push(`${dir}/%`); }
    if (qtxt) { where.push('f.rel_path LIKE ?'); params.push(`%${qtxt}%`); }
    const limit = Math.min(Number(url.searchParams.get('limit') || 300), 1000);
    const rows = db.prepare(`SELECT f.id, f.rel_path, f.role, f.size, a.id aid, a.name aname, a.type atype
      FROM files f JOIN assets a ON a.id=f.asset_id
      WHERE ${where.join(' AND ')} ORDER BY f.rel_path LIMIT ?`).all(...params, limit);
    return json(res, 200, { files: rows });
  }

  if (p === '/api/variants') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const rows = db.prepare(`SELECT id,name,type,rel_dir FROM assets
      WHERE library_id=? AND type IN ('material','model')`).all(lib) as any[];
    const norm = (name: string) => name.toLowerCase()
      .replace(/([_\-. ]?\d+k)(?=[_\-. ]|$)/ig, '')
      .replace(/([_\-. ]?lod[_\-. ]?\d+)/ig, '')
      .replace(/[_\-. ]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const resOf = (name: string) => {
      const m = name.match(/(\d+)k/i);
      return m ? Number(m[1]) : null;
    };
    const lodOf = (name: string) => {
      const m = name.match(/lod[_\-. ]?(\d+)/i);
      return m ? Number(m[1]) : null;
    };
    const map = new Map<string, any[]>();
    for (const r of rows) {
      const parent = String(r.rel_dir).split('/').slice(0, -1).join('/');
      const key = `${parent}|${norm(String(r.name))}`;
      const arr = map.get(key) || [];
      arr.push({ id: r.id, name: r.name, type: r.type, res: resOf(String(r.name)), lod: lodOf(String(r.name)) });
      map.set(key, arr);
    }
    const groups = [...map.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([key, items]) => ({ key, items }));
    return json(res, 200, { groups });
  }

  if (p === '/api/issues') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const raw = getIssues(lib);
    const ig = ignoredSet();
    const issues = (raw.issues as any[]).filter(i => !ig.has(`${i.assetId}|${i.kind}`));
    const ids = [...new Set(issues.map(i => i.assetId))];
    let rows: any[] = [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      rows = db.prepare(`SELECT * FROM assets WHERE id IN (${ph})`).all(...ids);
    }
    return json(res, 200, { issues, assets: rows, skipped: raw.skipped, ignored: raw.issues.length - issues.length });
  }

  const mAssetIssues = p.match(/^\/api\/asset-issues\/(\d+)$/);
  if (mAssetIssues) {
    const id = Number(mAssetIssues[1]);
    const a = db.prepare('SELECT library_id FROM assets WHERE id=?').get(id) as any;
    if (!a) return json(res, 404, { error: 'not found' });
    const raw = getIssues(a.library_id);
    const ig = ignoredSet();
    const issues = (raw.issues as any[])
      .filter(i => i.assetId === id)
      .map(i => ({ ...i, ignored: ig.has(`${i.assetId}|${i.kind}`) }));
    return json(res, 200, { issues });
  }

  if (p === '/api/issues/ignore' && req.method === 'POST') {
    const b = await body(req);
    const assetIds: number[] = (b.assetIds || []).map(Number).filter(Boolean);
    const kinds: string[] = Array.isArray(b.kinds) ? b.kinds.map(String) : [];
    if (!assetIds.length) return json(res, 400, { error: 'assetIds required' });
    for (const id of assetIds) {
      if (b.clear) {
        db.prepare('DELETE FROM issue_ignores WHERE asset_id=?').run(id);
        continue;
      }
      let ks = kinds;
      if (!ks.length) {
        const a = db.prepare('SELECT library_id FROM assets WHERE id=?').get(id) as any;
        if (!a) continue;
        ks = getIssues(a.library_id).issues.filter((i: any) => i.assetId === id).map((i: any) => i.kind);
      }
      for (const k of [...new Set(ks)]) {
        db.prepare('INSERT OR IGNORE INTO issue_ignores(asset_id,kind,created_at) VALUES(?,?,?)').run(id, k, Date.now());
      }
    }
    return json(res, 200, { ok: true });
  }


  if (p === '/api/check') {
    const lib = Number(url.searchParams.get('lib') || 0);
    return json(res, 200, checkLibrary(lib));
  }

  if (p === '/api/fix' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, fixIssue(b));
  }

  if (p === '/api/stats') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const rows = db.prepare('SELECT type, COUNT(*) c FROM assets WHERE library_id=? GROUP BY type').all(lib) as any[];
    const stats: Record<string, number> = {};
    for (const r of rows) stats[r.type] = r.c;
    return json(res, 200, { stats, total: Object.values(stats).reduce((a, b) => a + b, 0) });
  }

  if (p === '/api/tree') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const rows = db.prepare('SELECT rel_dir, COUNT(*) c FROM assets WHERE library_id=? GROUP BY rel_dir').all(lib) as any[];
    const agg = new Map<string, number>();
    for (const r of rows) {
      const segs = String(r.rel_dir).split('/').filter(Boolean);
      for (let i = 1; i <= segs.length; i++) {
        const key = segs.slice(0, i).join('/');
        agg.set(key, (agg.get(key) || 0) + r.c);
      }
    }
    const fileDirs = new Set<string>();
    if (url.searchParams.get('withFiles') === '1') {
      const frows = db.prepare(`SELECT f.rel_path FROM files f JOIN assets a ON a.id=f.asset_id WHERE a.library_id=?`).all(lib) as any[];
      for (const r of frows) {
        const dir = path.posix.dirname(String(r.rel_path).split(path.sep).join('/'));
        if (dir && dir !== '.') fileDirs.add(dir);
      }
    }
    const all = new Map(agg);
    for (const d of fileDirs) if (!all.has(d)) all.set(d, 0);
    const nodes = [...all.entries()]
      .map(([dir, count]) => ({
        dir,
        label: dir.split('/').pop() || dir,
        depth: dir.split('/').length - 1,
        count,
        kind: agg.has(dir) ? 'asset' : 'files'
      }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
    return json(res, 200, { nodes });
  }

  // static
  if (p.startsWith('/api/')) return json(res, 404, { error: 'no route' });

  let filePath = path.join(DIST, p === '/' ? 'index.html' : p);
  if (!filePath.startsWith(DIST)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(DIST, 'index.html');
  if (!fs.existsSync(filePath)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('请先构建前端: pnpm build');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
    else res.end();
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`AssetManager API on http://127.0.0.1:${PORT}  db=${DB_FILE}`);
});
