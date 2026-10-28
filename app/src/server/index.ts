import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb, upsertLibrary, listLibraries, assetUuid, assetIdByUuid } from '../core/db.ts';
import { scanLibrary, scanState } from '../core/scan.ts';
import { MCP_TOOLS, callTool } from '../core/mcp.ts';
import {
  bridgeStatus, sendJob, nextJob, finishJob, heartbeat, touchClient, recentJobs, jobById,
  installForMax, installInfo, maxStartupDirs, bridgeScriptPath, maxSeries as maxPluginSeries, writeLocator,
  pluginTargets, applyPluginTarget, maxPluginFileName,
  installForBlender, blenderSeries, blenderUserDirs,
  installForSu, suSeries as suPluginSeries, suUserDirs, suInstallInfo,
  installForUe, ueSeries as uePluginSeries, ueProjects, ueInstallInfo, addUeExtraProjects,
  installForMaya, mayaSeries as mayaPluginSeries, mayaUserDirs, mayaInstallInfo,
  resolvePath, assetInfo, writeDropScript,
  suConvertCheck,
  suClientSupportsGlb,
  BRIDGE_PROTOCOL, BRIDGE_SCRIPT_VERSION
} from '../core/bridge.ts';
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

/** 递归复制目录（插件按 Blender 版本分目录后，整份拷到数据目录便于手动安装） */
function copyTree(src: string, dst: string, skip = new Set<string>()) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to, skip);
    else if (e.isFile()) { try { fs.copyFileSync(from, to); } catch { /* ignore */ } }
  }
}

const APP_ROOT = process.env.AM_ROOT ? path.resolve(process.env.AM_ROOT) : findAppRoot(__dirname);
const DATA_DIR = process.env.AM_DATA ? path.resolve(process.env.AM_DATA) : path.join(APP_ROOT, 'data');
const DB_FILE = process.env.ASSETMANAGER_DB || path.join(DATA_DIR, 'library.db');
const DIST = path.join(APP_ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);

// ---------------------------------------------------------------- MCP（AI 客户端）
const MCP_CFG_FILE = path.join(DATA_DIR, 'mcp.json');
function mcpCfg() {
  let c = { enabled: true, allowWrite: false };
  try { c = { ...c, ...JSON.parse(fs.readFileSync(MCP_CFG_FILE, 'utf8')) }; } catch { /* default */ }
  return c;
}
function saveMcpCfg(patch: any) {
  const cur = mcpCfg();
  const next = { ...cur, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MCP_CFG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
// ---------------------------------------------------------------- 工作区（F-012）
const WS_FILE = path.join(DATA_DIR, 'workspace.json');
function wsCfg(): { path: string } {
  try { return { path: String((JSON.parse(fs.readFileSync(WS_FILE, 'utf8')) || {}).path || '') }; }
  catch { return { path: '' }; }
}
function wsBase() { return wsCfg().path || DATA_DIR; }
function wsPath(...parts: string[]) { return path.join(wsBase(), ...parts); }
function setWsPath(p: string) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WS_FILE, JSON.stringify({ path: p }, null, 2), 'utf8');
  process.env.AM_WORKSPACE = wsBase();
}
process.env.AM_WORKSPACE = wsBase();

const MCP_STDIO_SRC = `#!/usr/bin/env node
// AssetManager MCP stdio 代理：把 stdio 的 JSON-RPC 转发到本地 HTTP /mcp
const url = process.env.AM_MCP_URL || 'http://127.0.0.1:${process.env.PORT || 8787}/mcp';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
async function handle(line) {
  try {
    const msg = JSON.parse(line);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) });
    const text = await r.text();
    if (text) process.stdout.write(text.replace(/\n/g, '') + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: String((e && e.message) || e) } }) + '\n');
  }
}
`;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'mcp-stdio.mjs'), MCP_STDIO_SRC, 'utf8'); } catch { /* ignore */ }


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

/** 请求体按流写文件（渲染端导出的 GLB 上传用）；超上限直接掐断 */
function saveRequestBody(req: http.IncomingMessage, file: string, limitBytes = 300 * 1024 * 1024): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const ws = fs.createWriteStream(file);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        req.destroy();
        ws.destroy();
        reject(new Error('文件超过 300MB'));
      }
    });
    req.on('error', (e) => { ws.destroy(); reject(e); });
    req.pipe(ws);
    ws.on('finish', () => resolve(size));
    ws.on('error', (e) => reject(e));
  });
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 与 renderer/matlib.ts 的 DISP_SCALE 保持一致（服务端单独打包，不能跨端 import）
const DISP_SCALE = 0.03;

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
  // 置换：装配器预览是「0.5 中性、强度 × DISP_SCALE × 2」的 CPU 位移，这里写成同一口径的位移着色器
  let disp = '';
  if (height) {
    const strength = Number(ch.height?.strength ?? 1);
    const dsc = (Math.max(0, Number.isFinite(strength) ? strength : 1) * 2 * DISP_SCALE).toFixed(5);
    nodes.push('  <subtract name="h_center" type="float">\n    <input name="in1" type="float" nodename="img_Height" />\n    <input name="in2" type="float" value="0.5" />\n  </subtract>');
    nodes.push(`  <displacement name="disp_Height" type="displacementshader">\n    <input name="displacement" type="float" nodename="h_center" />\n    <input name="scale" type="float" value="${dsc}" />\n  </displacement>`);
    disp = '\n    <input name="displacementshader" type="displacementshader" nodename="disp_Height" />';
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
    <input name="surfaceshader" type="surfaceshader" nodename="${id}" />${disp}
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

function organizePlan(lib: number, dir = '') {
  const libRow = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
  if (!libRow) return { rows: [] };
  const root = libRow.root;
  const assets = (db.prepare('SELECT id,name,type,rel_dir FROM assets WHERE library_id=?').all(lib) as any[])
    .filter(a => !dir || a.rel_dir === dir || String(a.rel_dir).startsWith(dir + '/'));
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
  const rOp = url.searchParams.get('ratingOp');
  const rVal = Number(url.searchParams.get('ratingValue') || -1);
  if (rOp && rVal >= 0) {
    const inc = url.searchParams.get('ratingInclusive') === '1';
    if (rOp === 'gte') where.push(inc ? 'rating >= ?' : 'rating > ?');
    else if (rOp === 'lte') where.push(inc ? 'rating <= ?' : 'rating < ?');
    else where.push(inc ? 'rating = ?' : 'rating <> ?');
    params.push(rVal);
  }
  if (url.searchParams.get('fav') === '1') where.push('favorite = 1');
  if (url.searchParams.get('missingThumb') === '1') {
    where.push("type IN ('material','model') AND preview_rel IS NULL AND thumb_file IS NULL");
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

/** 最近一次从 AssetManager 拖出去的素材（内存即可；Max 的 #postImport 用它认素材） */
const lastDrag = new Map<string, { assetId: number; at: number }>();

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

  // ---------------- DCC 桥接（3ds Max 优先） ----------------
  if (p === '/api/bridge/status') {
    return json(res, 200, { ...bridgeStatus(db), port: PORT });
  }

  if (p === '/api/workspace') {
    const c = wsCfg();
    if (req.method === 'GET') return json(res, 200, { path: c.path, isSet: !!c.path, base: wsBase() });
    const b = await body(req);
    const want = String(b.path || '').trim();
    if (!want) return json(res, 400, { error: '路径为空' });
    if (!path.isAbsolute(want)) return json(res, 400, { error: '需要绝对路径' });
    const oldBase = wsBase();
    const oldLibs = (db.prepare('SELECT root FROM libraries').all() as any[]).map(r => String(r.root).toLowerCase());
    if (oldLibs.some(r => want.toLowerCase().startsWith(r))) return json(res, 400, { error: '工作区不能放在素材库目录内' });
    try {
      fs.mkdirSync(want, { recursive: true });
      // 迁移旧目录（仅迁移本软件生成的分类目录，不碰其它文件）
      const subs = [['cache', 'converted'], ['plugins'], ['geometry']];
      for (const parts of subs) {
        const from = path.join(oldBase, ...parts);
        const to = path.join(want, ...parts);
        if (!fs.existsSync(from) || from === to) continue;
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.cpSync(from, to, { recursive: true, force: true });
          fs.rmSync(from, { recursive: true, force: true });
        } catch { /* 迁移失败就保留旧文件 */ }
      }
      setWsPath(want);
      for (const parts of subs) { try { fs.mkdirSync(path.join(want, ...parts), { recursive: true }); } catch { /* ignore */ } }
      return json(res, 200, { ok: true, path: want, base: want });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }
  if (p === '/api/workspace/open' && req.method === 'POST') {
    const base = wsBase();
    try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
    return json(res, 200, { ok: true, path: base });
  }

  if (p === '/api/mcp/status') {
    const c = mcpCfg();
    return json(res, 200, {
      enabled: c.enabled, allowWrite: c.allowWrite, port: PORT,
      url: `http://127.0.0.1:${PORT}/mcp`,
      stdio: path.join(DATA_DIR, 'mcp-stdio.mjs')
    });
  }
  if (p === '/api/mcp/settings' && req.method === 'POST') {
    const b = await body(req);
    const patch: any = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.allowWrite !== undefined) patch.allowWrite = !!b.allowWrite;
    const c = saveMcpCfg(patch);
    return json(res, 200, {
      enabled: c.enabled, allowWrite: c.allowWrite, port: PORT,
      url: `http://127.0.0.1:${PORT}/mcp`,
      stdio: path.join(DATA_DIR, 'mcp-stdio.mjs')
    });
  }
  if (p === '/mcp' && req.method === 'POST') {
    const c = mcpCfg();
    if (!c.enabled) return json(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP 已在设置里关闭' } });
    const b = await body(req);
    const id = b?.id ?? null;
    const method = String(b?.method || '');
    if (!b || b.jsonrpc !== '2.0' || !method) {
      return json(res, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (method.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
    try {
      if (method === 'initialize') {
        return json(res, 200, { jsonrpc: '2.0', id, result: {
          protocolVersion: String(b?.params?.protocolVersion || '2024-11-05'),
          capabilities: { tools: {} },
          serverInfo: { name: 'AssetManager', version: '0.3.6' }
        } });
      }
      if (method === 'ping') return json(res, 200, { jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      if (method === 'tools/call') {
        const name = String(b?.params?.name || '');
        const args = b?.params?.arguments || {};
        const out = callTool(db, name, args, c.allowWrite);
        const isError = !!(out && (out as any).error);
        return json(res, 200, { jsonrpc: '2.0', id, result: {
          isError,
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }]
        } });
      }
      return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    } catch (e: any) {
      return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } });
    }
  }

  if (p === '/api/bridge/info') {
    return json(res, 200, {
      ...installInfo(APP_ROOT),
      port: PORT,
      protocol: BRIDGE_PROTOCOL,
      scriptVersion: BRIDGE_SCRIPT_VERSION
    });
  }

  // 拖放素材进来时按文件路径反查（返回源目录、材质规格、文件清单）
  if (p === '/api/bridge/resolve') {
    const q = req.method === 'POST' ? await body(req) : {};
    const filePath = String(q.path || url.searchParams.get('path') || '');
    const r = resolvePath(db, filePath);
    if (!r) return json(res, 404, { error: '这个文件不在任何素材库里' });
    return json(res, 200, r);
  }

  // 生成「拖放描述文件」：把 .ms 拖进 Max，Max 执行它 → 插件接管（材质菜单 / 摆放 / 环境贴图）
  if (p === '/api/bridge/dropfile' && req.method === 'POST') {
    const b = await body(req);
    const r = writeDropScript(db, Number(b.assetId), APP_ROOT);
    if (!r) return json(res, 404, { error: 'asset not found' });
    return json(res, 200, r);
  }

  const mBridgeAsset = p.match(/^\/api\/bridge\/asset\/(\d+)$/);
  if (mBridgeAsset) {
    const r = assetInfo(db, Number(mBridgeAsset[1]));
    if (!r) return json(res, 404, { error: 'asset not found' });
    return json(res, 200, r);
  }

  // Max 导回完成回调：按 UUID 找到素材 → 后台重扫该库，刷新文件/大小/预览
  if (p === '/api/bridge/max/exported' && req.method === 'POST') {
    const b = await body(req);
    const uuid = String(b.uuid || '');
    let assetId = uuid ? assetIdByUuid(db, uuid) : null;
    // 兼容：只给了目录时用「库根 + rel_dir」反查
    if (!assetId && b.dir) {
      const dirAbs = path.resolve(String(b.dir));
      const libs = listLibraries(db) as any[];
      for (const lib of libs) {
        const rootAbs = path.resolve(String(lib.root));
        if (dirAbs.toLowerCase().startsWith(rootAbs.toLowerCase())) {
          const rel = dirAbs.slice(rootAbs.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
          const row = db.prepare('SELECT id FROM assets WHERE library_id=? AND rel_dir=?').get(lib.id, rel) as any;
          if (row) { assetId = Number(row.id); break; }
        }
      }
    }
    if (!assetId) return json(res, 404, { ok: false, error: '找不到对应素材（UUID 未登记？）' });
    const a = db.prepare('SELECT library_id FROM assets WHERE id=?').get(assetId) as any;
    const lib = db.prepare('SELECT root FROM libraries WHERE id=?').get(a.library_id) as any;
    if (lib?.root && !scanState.running) {
      setTimeout(() => { try { scanLibrary(db, Number(a.library_id), path.resolve(String(lib.root))); } catch (e) { console.error('rescan after max export failed', e); } }, 10);
    }
    // 顺手把 UUID 映射镜像到工作空间（库重建后仍可找回）
    try {
      const rows = db.prepare("SELECT a.uuid, a.rel_dir, l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.uuid IS NOT NULL AND a.uuid<>''").all() as any[];
      const map: Record<string, string> = {};
      for (const r of rows) map[`${r.root}::${r.rel_dir}`] = String(r.uuid);
      fs.writeFileSync(path.join(DATA_DIR, 'asset-uuids.json'), JSON.stringify(map, null, 2), 'utf8');
    } catch { /* ignore */ }
    return json(res, 200, { ok: true, assetId, rescanning: !scanState.running });
  }

  // 拖放提示：AssetManager 开始拖拽某个素材时登记一次，Max 的 #postImport 据此认素材
  if (p === '/api/bridge/dragging') {
    if (req.method === 'POST') {
      const b = await body(req);
      lastDrag.set(String(b.target || 'max'), { assetId: Number(b.assetId) || 0, at: Date.now() });
      return json(res, 200, { ok: true });
    }
    const t = String(url.searchParams.get('target') || 'max');
    const d = lastDrag.get(t);
    if (!d || Date.now() - d.at > 120000) return json(res, 200, { dragging: null });
    return json(res, 200, { dragging: { assetId: d.assetId, at: d.at, asset: assetInfo(db, d.assetId) } });
  }

  if (p === '/api/bridge/jobs') {
    const target = url.searchParams.get('target') || 'max';
    return json(res, 200, { jobs: recentJobs(db, target, Number(url.searchParams.get('limit') || 20)) });
  }

  if (p === '/api/bridge/clear' && req.method === 'POST') {
    const b = await body(req);
    const target = String(b.target || '');
    const rows = (target
      ? db.prepare('SELECT asset_id FROM bridge_jobs WHERE target=?').all(target)
      : db.prepare('SELECT asset_id FROM bridge_jobs').all()) as any[];
    const del = target
      ? db.prepare('DELETE FROM bridge_jobs WHERE target=?').run(target)
      : db.prepare('DELETE FROM bridge_jobs').run();
    // 一并删除这些任务产生的本地临时文件（拖放描述 .ms）
    let removedFiles = 0;
    try {
      const dir = path.join(os.tmpdir(), 'AssetManager', 'drops');
      const ids = new Set(rows.map(r => Number(r.asset_id)).filter(Boolean));
      for (const name of fs.readdirSync(dir)) {
        const m = name.match(/^am-drop-(\d+)\.ms$/);
        if (!m) continue;
        if (target && !ids.has(Number(m[1]))) continue;
        try { fs.unlinkSync(path.join(dir, name)); removedFiles++; } catch { /* ignore */ }
      }
    } catch { /* 目录不存在 */ }
    // 一并删除软件为 SketchUp 导出的临时 GLB
    try {
      const dir = wsPath('cache', 'converted');
      for (const name of fs.readdirSync(dir)) {
        if (!/\.glb$/i.test(name)) continue;
        try { fs.unlinkSync(path.join(dir, name)); removedFiles++; } catch { /* ignore */ }
      }
    } catch { /* 目录不存在 */ }
    return json(res, 200, { ok: true, deleted: Number(del.changes || 0), removedFiles });
  }

  const mBridgeJob = p.match(/^\/api\/bridge\/job\/(\d+)$/);
  if (mBridgeJob) {
    const j = jobById(db, Number(mBridgeJob[1]));
    if (!j) return json(res, 404, { error: 'not found' });
    return json(res, 200, j);
  }

  if (p === '/api/bridge/send' && req.method === 'POST') {
    const b = await body(req);
    const assetId = Number(b.assetId);
    const mode = String(b.mode || 'import');
    const target = String(b.target || 'max');
    const modelPath = String(b.modelPath || '');
    const convertedFrom = String(b.convertedFrom || '').replace(/[^.\w]/g, '').slice(0, 8);
  const options = b.options && typeof b.options === 'object' ? b.options : undefined;
    if (!assetId) return json(res, 400, { error: 'assetId required' });
    if (!['import', 'material', 'texture', 'hdri', 'ies'].includes(mode)) return json(res, 400, { error: '未知的发送模式' });
    if (!['max', 'blender', 'su', 'ue', 'maya'].includes(target)) return json(res, 400, { error: '未知的发送目标' });
    if (mode === 'ies' && target !== 'ue' && target !== 'maya') {
      return json(res, 400, { error: 'IES 配光文件目前只有 Unreal Engine / Maya(Arnold) 支持' });
    }

    // SketchUp 读不了的模型格式（FBX/OBJ/PLY）：先让渲染端用 three 转成 GLB 再发
    if (target === 'su' && mode === 'import' && !modelPath) {
      const conv = suConvertCheck(db, assetId);
      if (conv && conv.convertible) {
        // SketchUp 2024 起才有 GLB 导入器（glbimporter.dll）；更老的版本不再支持
        if (!suClientSupportsGlb(db)) {
          return json(res, 400, {
            error: `目标 SketchUp 没有 GLB 导入器，无法导入 ${conv.ext}。` +
              '本插件支持 SketchUp 2024 及以上；更老的版本请改用 STL / SKP 版本的素材。'
          });
        }
        return json(res, 200, { needsConvert: true, ...conv });
      }
      if (conv && !conv.convertible) {
        return json(res, 400, {
          error: `SketchUp 读不了 ${conv.ext}，软件也只能把 FBX/OBJ/PLY 转成 GLB`
        });
      }
    }

    // 覆盖模型只接受软件自己导出的临时文件（不碰素材目录）
    let override = '';
    if (modelPath) {
      const dir = path.resolve(wsBase(), 'cache', 'converted');
      const abs = path.resolve(modelPath);
      if (!abs.toLowerCase().startsWith(dir.toLowerCase()) || !fs.existsSync(abs)) {
        return json(res, 400, { error: 'modelPath 只接受软件导出的临时 GLB' });
      }
      override = abs;
    }

    const r = override
      ? sendJob(db, assetId, target, mode, {
          options,
          modelPath: override,
          titleSuffix: convertedFrom ? `（${convertedFrom.replace('.', '').toUpperCase()}→GLB）` : '（→GLB）'
        })
      : sendJob(db, assetId, target, mode, { options });
    if ('error' in r) return json(res, 400, r);
    return json(res, 200, r);
  }

  // 渲染端把导出的 GLB 传上来：临时文件，只给 DCC 导入用，素材文件一个字节都不动
  if (p === '/api/bridge/convert' && req.method === 'POST') {
    const assetId = Number(url.searchParams.get('assetId') || 0);
    const raw = String(url.searchParams.get('name') || 'model');
    const safe = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'model';
    const format = (url.searchParams.get('format') || 'glb').toLowerCase();
    const dir = wsPath('cache', 'converted');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

    const file = path.join(dir, `${assetId || 'x'}-${safe}.glb`);
    try {
      const size = await saveRequestBody(req, file);
      if (!size) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        return json(res, 400, { ok: false, error: '空文件' });
      }
      return json(res, 200, { ok: true, path: file, size });
    } catch (e: any) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  // 统一插件安装/卸载：列出本机每个 DCC 的每个版本（勾选=安装，取消=卸载）
  if (p === '/api/bridge/plugin-targets') {
    return json(res, 200, { targets: pluginTargets(APP_ROOT, DATA_DIR), maxFile: maxPluginFileName() });
  }
  if (p === '/api/bridge/plugin-target' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, applyPluginTarget(APP_ROOT, String(b.key || ''), !!b.install, DATA_DIR));
  }
  // UE：把「手动选择」的工程记下来，之后它就和最近打开的工程一样出现在勾选列表里
  if (p === '/api/bridge/ue-add-project' && req.method === 'POST') {
    const b = await body(req);
    const files = Array.isArray(b.files) ? b.files.map(String) : [];
    if (!files.length) return json(res, 400, { error: 'files required（.uproject 绝对路径）' });
    const kept = addUeExtraProjects(DATA_DIR, files);
    return json(res, 200, { ok: true, saved: kept, targets: pluginTargets(APP_ROOT, DATA_DIR) });
  }

  if (p === '/api/bridge/install' && req.method === 'POST') {
    return json(res, 200, { ...installForMax(APP_ROOT), series: maxPluginSeries(APP_ROOT) });
  }

  // 一键把 Blender 插件装进本机所有 Blender 用户目录（按各版本挑对应系列）
  if (p === '/api/bridge/install-blender' && req.method === 'POST') {
    return json(res, 200, installForBlender(APP_ROOT));
  }

  // 只查不装：包里的系列 + 本机 Blender 用户目录
  if (p === '/api/bridge/blender-where' && req.method === 'GET') {
    return json(res, 200, { series: blenderSeries(APP_ROOT), dirs: blenderUserDirs() });
  }

  // 一键把 SketchUp 插件装进本机所有 SketchUp 用户目录（按各版本挑对应系列）
  if (p === '/api/bridge/install-su' && req.method === 'POST') {
    return json(res, 200, installForSu(APP_ROOT));
  }

  // 只查不装：包里的 SketchUp 系列 + 本机 SketchUp 用户目录 + 已装版本
  if (p === '/api/bridge/su-where' && req.method === 'GET') {
    return json(res, 200, { ...suInstallInfo(APP_ROOT), series: suPluginSeries(APP_ROOT), dirs: suUserDirs() });
  }

  // 一键把 UE 插件装进**用户选中的** UE 工程（按各工程引擎版本挑对应系列）
  // 必须显式给 projects：不再默认往本机所有最近工程里塞
  if (p === '/api/bridge/install-ue' && req.method === 'POST') {
    const b = await body(req);
    const only = Array.isArray(b?.projects) ? b.projects.map((x: any) => String(x)).filter(Boolean) : [];
    if (!only.length) {
      return json(res, 400, { ok: false, error: '请先选择要安装的 UE 工程（projects 为空）' });
    }
    return json(res, 200, installForUe(APP_ROOT, only));
  }

  // 只查不装：包里的 UE 系列 + 本机 UE 工程 + 已装版本
  if (p === '/api/bridge/ue-where' && req.method === 'GET') {
    return json(res, 200, {
      ...ueInstallInfo(APP_ROOT),
      series: uePluginSeries(APP_ROOT),
      projects: ueProjects().map(x => ({ name: x.name, file: x.file, engine: x.engine }))
    });
  }

  // 一键把 Maya 插件装进本机所有 Maya 用户目录（按各年份挑对应系列，写 .mod + scripts）
  if (p === '/api/bridge/install-maya' && req.method === 'POST') {
    return json(res, 200, installForMaya(APP_ROOT));
  }

  // 只查不装：包里的 Maya 系列 + 本机 Maya 用户目录 + 已装版本
  if (p === '/api/bridge/maya-where' && req.method === 'GET') {
    return json(res, 200, { ...mayaInstallInfo(APP_ROOT), series: mayaPluginSeries(APP_ROOT), dirs: mayaUserDirs() });
  }

  if (p === '/api/bridge/test' && req.method === 'POST') {
    const st = bridgeStatus(db);
    const max = (st.targets as any).max;
    return json(res, 200, { ok: !!max?.connected, target: 'max', connected: !!max?.connected, lastSeen: max?.lastSeen ?? null });
  }

  if (p === '/api/bridge/open-folder' && req.method === 'POST') {
    const b = await body(req);
    const which = String(b.which || 'startup');
    const scriptPath = bridgeScriptPath(APP_ROOT);
    const dirs = maxStartupDirs();
    let dir = '';
    if (which === 'script') {
      dir = fs.existsSync(scriptPath) ? path.dirname(scriptPath) : '';
    } else if (which === 'copy') {
      // Max 插件按 Max 版本分目录（2026/ 2027/ …）：整份复制，用户按自己的版本取文件
      const outDir = path.join(DATA_DIR, 'plugins', '3dsmax');
      try {
        copyTree(path.join(APP_ROOT, 'bridge', 'max'), outDir, new Set(['tools']));
      } catch { /* ignore */ }
      dir = outDir;
    } else if (which === 'blender') {
      // 插件按 Blender 版本分目录（3.6/ 4.0/ …）：整份复制，用户按自己的版本取文件
      const outDir = path.join(DATA_DIR, 'plugins', 'blender');
      try {
        copyTree(path.join(APP_ROOT, 'bridge', 'blender'), outDir, new Set(['tools', '__pycache__']));
      } catch { /* ignore */ }
      dir = outDir;
    } else if (which === 'su') {
      // SketchUp 插件同样按版本分目录（2026/ 2025/ …），整份复制便于手动安装
      const outDir = path.join(DATA_DIR, 'plugins', 'sketchup');
      try {
        copyTree(path.join(APP_ROOT, 'bridge', 'su'), outDir, new Set(['tools', '__pycache__']));
      } catch { /* ignore */ }
      dir = outDir;
    } else if (which === 'ue') {
      // UE 插件按引擎版本分目录（5.7/ …），整份复制便于手动拷进工程的 Plugins
      const outDir = path.join(DATA_DIR, 'plugins', 'unreal');
      try {
        copyTree(path.join(APP_ROOT, 'bridge', 'ue'), outDir, new Set(['tools', '__pycache__']));
      } catch { /* ignore */ }
      dir = outDir;
    } else if (which === 'maya') {
      // Maya 插件按年份分目录（2025/ …）：整份复制，用户也可以自己拷进 Documents\maya\modules
      const outDir = path.join(DATA_DIR, 'plugins', 'maya');
      try {
        copyTree(path.join(APP_ROOT, 'bridge', 'maya'), outDir, new Set(['tools', '__pycache__']));
      } catch { /* ignore */ }
      dir = outDir;
    } else if (which === 'geometry') {
      const outDir = wsPath('geometry');
      try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
      dir = outDir;
    } else {
      dir = dirs[0] || '';
    }
    if (!dir) return json(res, 404, { error: '没有找到 3ds Max startup 目录，请先启动一次 3ds Max' });
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    return json(res, 200, { ok: true, path: dir });
  }

  // 插件侧接口：/api/bridge/<target>/(next|result|heartbeat)
  const mBridgeTarget = p.match(/^\/api\/bridge\/(max|su|blender|houdini|ue|maya)\/(next|result|heartbeat)$/);
  if (mBridgeTarget) {
    const target = mBridgeTarget[1];
    const action = mBridgeTarget[2];

    if (action === 'next' && req.method === 'GET') {
      touchClient(db, target);
      const job = nextJob(db, target);
      if (!job) { res.writeHead(204); return res.end(); }
      return json(res, 200, job);
    }

    if (action === 'heartbeat' && req.method === 'POST') {
      const b = await body(req);
      return json(res, 200, heartbeat(db, target, b.version, b.host, b));
    }

    if (action === 'result' && req.method === 'POST') {
      const b = await body(req);
      const id = Number(b.id);
      if (!id) return json(res, 400, { error: 'id required' });
      return json(res, 200, finishJob(db, target, id, !!b.ok, b.message, b.detail));
    }
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
      )) AS has_image,
      (SELECT f3.rel_path FROM files f3 WHERE f3.asset_id = a.id AND (
        f3.role IN ('model','main','map')
        OR lower(f3.rel_path) LIKE '%.fbx' OR lower(f3.rel_path) LIKE '%.obj' OR lower(f3.rel_path) LIKE '%.glb'
        OR lower(f3.rel_path) LIKE '%.hdr' OR lower(f3.rel_path) LIKE '%.exr'
        OR lower(f3.rel_path) LIKE '%.png' OR lower(f3.rel_path) LIKE '%.jpg' OR lower(f3.rel_path) LIKE '%.jpeg'
        OR lower(f3.rel_path) LIKE '%.tga' OR lower(f3.rel_path) LIKE '%.tif' OR lower(f3.rel_path) LIKE '%.tiff'
      ) ORDER BY CASE f3.role WHEN 'model' THEN 0 WHEN 'main' THEN 1 WHEN 'map' THEN 2 ELSE 3 END,
                 CASE WHEN lower(f3.rel_path) LIKE '%.hdr' OR lower(f3.rel_path) LIKE '%.exr' THEN 0 ELSE 1 END,
                 f3.rel_path LIMIT 1) AS drag_rel
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
    // 回写时插件会写 asset_maps.json（槽位→文件名），有它就按它来，避免预览按文件名猜错通道
    let slotMap: Record<string, string> | null = null;
    try {
      if (lib?.root) {
        const mp = path.join(lib.root, String(a.rel_dir), 'asset_maps.json');
        if (fs.existsSync(mp)) {
          const raw = JSON.parse(fs.readFileSync(mp, 'utf8'));
          const map: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw)) {
            const name = String(v).toLowerCase();
            const hit = (files as any[]).find(f => String(f.rel_path).split('/').pop()?.toLowerCase() === name)
              || (files as any[]).find(f => String(f.rel_path).toLowerCase().endsWith('/' + name));
            if (hit) map[k] = hit.rel_path;
          }
          if (Object.keys(map).length) slotMap = map;
        }
      }
    } catch { /* ignore */ }
    return json(res, 200, { ...a, root: lib?.root, files, tags, slotMap });
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
      'cache-control': 'no-store'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/texture/export' && req.method === 'POST') {
    const b = await body(req);
    const f = db.prepare(`SELECT f.rel_path, l.root, l.id AS lib FROM files f
      JOIN assets a ON a.id=f.asset_id JOIN libraries l ON l.id=a.library_id WHERE f.id=?`).get(Number(b.fileId)) as any;
    const m = String(b.dataUrl || '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
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
    fs.writeFileSync(out, Buffer.from(m[2], 'base64'));
    setTimeout(() => { try { scanLibrary(db, f.lib, f.root); } catch (e) { console.error('rescan failed', e); } }, 200);
    return json(res, 200, { path: out, overwritten: out === src });
  }

  const mOverrides = p.match(/^\/api\/model\/(\d+)\/overrides$/);
  if (mOverrides) {
    const id = Number(mOverrides[1]);
    const a = db.prepare('SELECT rel_dir, name, type FROM assets WHERE id=?').get(id) as any;
    if (!a) return json(res, 404, { error: 'not found' });
    const key = `${a.rel_dir}|${a.name}|${a.type}`;
    if (req.method === 'GET') {
      const rows = db.prepare('SELECT material, channel, file_rel, swizzle FROM material_overrides WHERE asset_key=?').all(key) as any[];
      const out: Record<string, Record<string, any>> = {};
      for (const r of rows) {
        out[r.material] = out[r.material] || {};
        out[r.material][r.channel] = { rel: r.file_rel, swizzle: r.swizzle || 'rgb' };
      }
      return json(res, 200, { overrides: out });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const b = await body(req);
      const material = String(b.material || '').trim();
      const channel = String(b.channel || '').trim();
      const fileRel = b.fileRel ? String(b.fileRel) : '';
      const swizzle = ['rgb', 'r', 'g', 'b', 'a'].includes(String(b.swizzle || '')) ? String(b.swizzle) : 'rgb';
      if (!material || !channel) return json(res, 400, { error: 'bad request' });
      if (!fileRel) {
        db.prepare('DELETE FROM material_overrides WHERE asset_key=? AND material=? AND channel=?').run(key, material, channel);
      } else {
        db.prepare(`INSERT INTO material_overrides(asset_key, material, channel, file_rel, swizzle, updated_at)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(asset_key, material, channel) DO UPDATE SET file_rel=excluded.file_rel, swizzle=excluded.swizzle, updated_at=excluded.updated_at`)
          .run(key, material, channel, fileRel, swizzle, Date.now());
      }
      // 写穿：把选中的贴图复制到素材目录、覆盖「被替换的那张」同名文件（保留文件名 = 模型里的贴图索引不变），
      // 这样模型直接导入 DCC 时用的就是替换后的图。覆盖前备份到 %TEMP%\AssetManager\texbackup\
      let wrote = '';
      const replaceFileId = Number(b.replaceFileId || 0);
      if (fileRel && replaceFileId > 0) {
        try {
          const tf = db.prepare('SELECT rel_path FROM files WHERE id=? AND asset_id=?').get(replaceFileId, id) as any;
          const lib = db.prepare('SELECT l.root FROM libraries l JOIN assets a ON a.library_id=l.id WHERE a.id=?').get(id) as any;
          if (tf && lib?.root && !/preview/i.test(String(tf.rel_path))) {
            const dst = path.join(String(lib.root), String(tf.rel_path));
            const src = path.join(String(lib.root), fileRel);
            if (fs.existsSync(src) && fs.existsSync(dst) && path.resolve(src) !== path.resolve(dst)) {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const bdir = path.join(os.tmpdir(), 'AssetManager', 'texbackup', stamp);
              fs.mkdirSync(bdir, { recursive: true });
              fs.copyFileSync(dst, path.join(bdir, path.basename(dst)));
              fs.copyFileSync(src, dst);
              wrote = dst;
            }
          }
        } catch (e) { console.error('override write-through failed', e); }
      }
      return json(res, 200, { ok: true, wrote });
    }
  }

  if (p === '/api/override-file') {
    const id = Number(url.searchParams.get('assetId') || 0);
    const rel = String(url.searchParams.get('rel') || '');
    const a = db.prepare(`SELECT a.rel_dir, a.name, a.type, l.root FROM assets a
      JOIN libraries l ON l.id=a.library_id WHERE a.id=?`).get(id) as any;
    if (!a || !rel) return json(res, 404, { error: 'not found' });
    const key = `${a.rel_dir}|${a.name}|${a.type}`;
    const hit = db.prepare('SELECT 1 FROM material_overrides WHERE asset_key=? AND file_rel=?').get(key, rel);
    if (!hit) return json(res, 403, { error: 'not allowed' });
    const abs = path.resolve(a.root, rel);
    if (!abs.startsWith(path.resolve(a.root)) || !fs.existsSync(abs)) return json(res, 404, { error: 'missing' });
    const ext = path.extname(abs).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tga': 'image/x-tga', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
    res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
    return fs.createReadStream(abs).pipe(res);
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
    db.prepare('UPDATE assets SET thumb_file=?, preview_rel=NULL WHERE id=?').run(relFile, Number(mThumbSave[1]));
    return json(res, 200, { ok: true, file });
  }

  const mHead = p.match(/^\/api\/file-head\/(\d+)$/);
  if (mHead) {
    const f = db.prepare('SELECT f.rel_path, l.root FROM files f JOIN assets a ON a.id=f.asset_id JOIN libraries l ON l.id=a.library_id WHERE f.id=?').get(Number(mHead[1])) as any;
    if (!f) return json(res, 404, { error: 'not found' });
    const full = path.join(f.root, f.rel_path);
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(32);
      const n = fs.readSync(fd, buf, 0, 32, 0);
      fs.closeSync(fd);
      return json(res, 200, { head: buf.slice(0, n).toString('latin1') });
    } catch {
      return json(res, 404, { error: 'missing' });
    }
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
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size, 'cache-control': 'no-store' });
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
    const thumbExt = path.extname(file).toLowerCase();
    // HDR/EXR 原图几十 MB，绝不能当缩略图发（B-003）
    if (thumbExt === '.hdr' || thumbExt === '.exr') return json(res, 404, { error: 'no bitmap preview' });
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

  if (p === '/api/previews') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const dir = String(url.searchParams.get('dir') || '');
    const libRow = db.prepare('SELECT root FROM libraries WHERE id=?').get(lib) as any;
    if (!libRow) return json(res, 404, { error: 'library not found' });
    const rows = db.prepare(`SELECT a.id aid, a.name, a.preview_rel, f.id fid, f.size
      FROM assets a JOIN files f ON f.asset_id=a.id AND f.rel_path=a.preview_rel
      WHERE a.library_id=?`).all(lib) as any[];
    const out = rows.filter(r => !dir || r.preview_rel === dir || String(r.preview_rel).startsWith(dir + '/'))
      .filter(r => /\.(jpe?g|png|webp)$/i.test(String(r.preview_rel)));
    return json(res, 200, { previews: out });
  }
  const mW = p.match(/^\/api\/preview\/write\/(\d+)$/);
  if (mW && req.method === 'POST') {
    const fid = Number(mW[1]);
    const row = db.prepare('SELECT f.rel_path, l.root FROM files f JOIN assets a ON a.id=f.asset_id JOIN libraries l ON l.id=a.library_id WHERE f.id=?').get(fid) as any;
    if (!row) return json(res, 404, { error: 'file not found' });
    if (!/\.(jpe?g|png|webp)$/i.test(row.rel_path)) return json(res, 400, { error: 'only image files' });
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => { total += c.length; if (total > 40 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve());
      req.on('error', reject);
    });
    try {
      fs.writeFileSync(path.join(row.root, row.rel_path), Buffer.concat(chunks));
      return json(res, 200, { ok: true, bytes: total });
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  if (p === '/api/organize/plan') {
    return json(res, 200, organizePlan(Number(url.searchParams.get('lib') || 0), String(url.searchParams.get('dir') || '')));
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
    // B-001：文件视图与素材网格共用同一套筛选
    if (url.searchParams.get('filter') === '1') {
      const fq = assetQuery(url);
      where.push(`a.id IN (SELECT id FROM assets WHERE ${fq.where})`);
      params.push(...fq.params);
    }
    const limit = Math.min(Number(url.searchParams.get('limit') || 300), 1000);
    const fileKind = (rel: string) => {
      const p = String(rel).toLowerCase();
      if (/\.(fbx|obj|glb|gltf|stl|3ds|abc|usdz|blend|max)$/.test(p)) return 'model';
      if (/\.(hdr|exr)$/.test(p)) return 'hdri';
      if (/\.ies$/.test(p)) return 'ies';
      if (/\.(dwg|dxf)$/.test(p)) return 'drawing';
      if (/\.(png|jpe?g|webp|bmp|tga|tiff?)$/.test(p)) return 'texture';
      return 'other';
    };
    const exKinds = (url.searchParams.get('excludeFileKind') || '').split(',').filter(Boolean);
    let rows = db.prepare(`SELECT f.id, f.rel_path, f.role, f.size, a.id aid, a.name aname, a.type atype
      FROM files f JOIN assets a ON a.id=f.asset_id
      WHERE ${where.join(' AND ')} ORDER BY f.rel_path LIMIT ?`).all(...params, exKinds.length ? limit * 8 : limit) as any[];
    if (exKinds.length) rows = rows.filter(r => !exKinds.includes(fileKind(r.rel_path))).slice(0, limit);
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

  if (p === '/api/geometry/list' && req.method === 'GET') {
    const dir = wsPath('geometry');
    fs.mkdirSync(dir, { recursive: true });
    const kinds = ['sphere', 'box', 'cylinder', 'plane'];
    const out: any[] = [];
    try {
      for (const n of fs.readdirSync(dir)) {
        const base = n.replace(/\.[^.]+$/, '').toLowerCase();
        const ext = path.extname(n).toLowerCase();
        if (kinds.includes(base) && ['.glb', '.gltf', '.obj', '.fbx'].includes(ext)) {
          const st = fs.statSync(path.join(dir, n));
          out.push({ kind: base, file: n, ext, size: st.size, mtime: st.mtimeMs });
        }
      }
    } catch { /* ignore */ }
    return json(res, 200, { dir, files: out });
  }

  if (p === '/api/geometry/file') {
    const kind = String(url.searchParams.get('kind') || '').toLowerCase();
    if (!['sphere', 'box', 'cylinder', 'plane'].includes(kind)) return json(res, 400, { error: 'bad kind' });
    const dir = wsPath('geometry');
    const order = ['.glb', '.gltf', '.obj', '.fbx'];
    let hit = '';
    for (const ext of order) {
      const f = path.join(dir, kind + ext);
      if (fs.existsSync(f)) { hit = f; break; }
    }
    if (!hit) return json(res, 404, { error: 'no custom geometry' });
    const ext = path.extname(hit).toLowerCase();
    const mime = ext === '.glb' ? 'model/gltf-binary' : ext === '.gltf' ? 'model/gltf+json'
      : ext === '.obj' ? 'text/plain' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'x-ext': ext, 'cache-control': 'no-cache' });
    return fs.createReadStream(hit).pipe(res);
  }

  if (p === '/api/path/write-text' && req.method === 'POST') {
    const b = await body(req);
    const dir = String(b.dir || '');
    const name = String(b.name || '').replace(/[\\/:*?"<>|]/g, '_');
    if (!dir || !name || typeof b.text !== 'string') return json(res, 400, { error: 'bad request' });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 404, { error: '目录不存在' });
    const out = path.join(dir, name);
    fs.writeFileSync(out, String(b.text), 'utf8');
    return json(res, 200, { path: out });
  }

  if (p === '/api/path/write-image' && req.method === 'POST') {
    const b = await body(req);
    const dir = String(b.dir || '');
    const name = String(b.name || '').replace(/[\\/:*?"<>|]/g, '_');
    const m = String(b.dataUrl || '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
    if (!dir || !name || !m) return json(res, 400, { error: 'bad request' });
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 404, { error: '目录不存在' });
    const out = path.join(dir, name);
    fs.writeFileSync(out, Buffer.from(m[2], 'base64'));
    return json(res, 200, { path: out });
  }

  if (p === '/api/folder/textures' && req.method === 'GET') {
    const dir = String(url.searchParams.get('path') || '');
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return json(res, 404, { error: '目录不存在' });
    }
    const out: any[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 1) return;
      let names: string[] = [];
      try { names = fs.readdirSync(d); } catch { return; }
      for (const n of names) {
        const full = path.join(d, n);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.(png|jpe?g|webp|bmp|tga|tiff?)$/i.test(n)) continue;
        out.push({ path: full, rel: path.relative(dir, full).split(path.sep).join('/'), size: st.size });
      }
    };
    walk(dir, 0);
    return json(res, 200, { folder: dir, files: out });
  }

  if (p === '/api/path-file') {
    const file = String(url.searchParams.get('path') || '');
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'missing' });
    if (!/\.(png|jpe?g|webp|bmp|tga|tiff?|hdr|exr)$/i.test(file)) return json(res, 403, { error: 'not allowed' });
    const ext = path.extname(file).toLowerCase();
    const mime: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
      '.bmp': 'image/bmp', '.tga': 'image/x-tga', '.tif': 'image/tiff', '.tiff': 'image/tiff'
    };
    res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/asset/write-text' && req.method === 'POST') {
    const b = await body(req);
    const id = Number(b.assetId);
    const name = String(b.name || '').replace(/[\\/:*?"<>|]/g, '_');
    if (!id || !name || typeof b.text !== 'string') return json(res, 400, { error: 'bad request' });
    const a = db.prepare(`SELECT a.rel_dir, l.root FROM assets a
      JOIN libraries l ON l.id=a.library_id WHERE a.id=?`).get(id) as any;
    if (!a) return json(res, 404, { error: 'not found' });
    const dir = path.join(a.root, a.rel_dir);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, name);
    fs.writeFileSync(out, String(b.text), 'utf8');
    return json(res, 200, { path: out });
  }

  if (p === '/api/preview/write' && req.method === 'POST') {
    const b = await body(req);
    const m = String(b.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    const id = Number(b.assetId);
    if (!m || !id) return json(res, 400, { error: 'bad request' });
    const a = db.prepare(`SELECT a.rel_dir, a.name, a.type, l.root FROM assets a
      JOIN libraries l ON l.id=a.library_id WHERE a.id=?`).get(id) as any;
    if (!a) return json(res, 404, { error: 'not found' });
    const dir = path.join(a.root, a.rel_dir);
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(a.name).replace(/[\\/:*?"<>|]/g, '_');
    const wanted = b.name ? String(b.name).replace(/[\\/:*?"<>|]/g, '_') : '';
    const fileName = wanted || `${safe}_Preview.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(dir, fileName), Buffer.from(m[2], 'base64'));
    const rel = `${a.rel_dir}/${fileName}`.replace(/^\/+/, '');
    db.prepare('UPDATE assets SET preview_rel=?, thumb_file=NULL WHERE id=?').run(rel, id);
    return json(res, 200, { path: path.join(dir, fileName), rel });
  }

  if (p === '/api/preview/rematch' && req.method === 'POST') {
    const b = await body(req);
    const ids = (Array.isArray(b.assetIds) ? b.assetIds : []).map(Number).filter(Boolean);
    const out: any[] = [];
    for (const id of ids) {
      try {
        const a = db.prepare(`SELECT a.rel_dir, a.name, a.type, l.root FROM assets a
          JOIN libraries l ON l.id=a.library_id WHERE a.id=?`).get(id) as any;
        if (!a) { out.push({ id, ok: false, error: '素材不存在' }); continue; }
        const absDir = path.join(a.root, a.rel_dir);
        if (!fs.existsSync(absDir)) { out.push({ id, ok: false, error: '目录不存在' }); continue; }
        const names = fs.readdirSync(absDir).filter(n => /\.(png|jpe?g|webp|bmp|tif?f|pdf)$/i.test(n));
        const isName = (n: string) => {
          const base = a.name.toLowerCase().replace(/\s+/g, '');
          const s = n.toLowerCase().replace(/\s+/g, '');
          return s.includes(base) || base.includes(s.replace(/\.[a-z0-9]+$/, ''));
        };
        const pick = names.find(n => /_preview\./i.test(n) && isName(n))
          || names.find(n => /_preview\./i.test(n))
          || names.find(n => /_render\./i.test(n))
          || names.find(n => /preview/i.test(n))
          || null;
        if (!pick) { out.push({ id, ok: false, error: '目录内没有预览图' }); continue; }
        const rel = `${a.rel_dir}/${pick}`.replace(/^\/+/, '');
        db.prepare('UPDATE assets SET preview_rel=?, thumb_file=NULL WHERE id=?').run(rel, id);
        out.push({ id, ok: true, path: rel });
      } catch (e: any) {
        out.push({ id, ok: false, error: String(e?.message || e) });
      }
    }
    const okCount = out.filter(r => r.ok).length;
    return json(res, 200, { ok: okCount, total: out.length, results: out });
  }

  if (p === '/api/issues') {
    const lib = Number(url.searchParams.get('lib') || 0);
    const raw = getIssues(lib);
    const ig = ignoredSet();
    let issues = (raw.issues as any[]).filter(i => !ig.has(`${i.assetId}|${i.kind}`));
    // B-001：问题视图同样受当前筛选影响
    if (url.searchParams.get('filter') === '1') {
      const fq = assetQuery(url);
      const allowed = new Set((db.prepare(`SELECT id FROM assets WHERE ${fq.where}`).all(...fq.params) as any[]).map(r => r.id));
      issues = issues.filter(i => allowed.has(i.assetId));
    }
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
  // 把端口写到 %LOCALAPPDATA%\AssetManager\bridge.json，MaxScript 插件据此找到服务
  const version = (() => {
    try { return String(JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0'); }
    catch { return '0.0.0'; }
  })();
  const locator = writeLocator(PORT, APP_ROOT, version);
  console.log(`AssetManager API on http://127.0.0.1:${PORT}  db=${DB_FILE}  bridge=${locator || '(locator failed)'}`);
  // 清理上一轮给 SketchUp 导出的临时 GLB（超过 24 小时的）
  try {
    const dir = wsPath('cache', 'converted');
    const keepMs = 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try { if (Date.now() - fs.statSync(f).mtimeMs > keepMs) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  } catch { /* 目录不存在 */ }
});
