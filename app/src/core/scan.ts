import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.ts';
import type { AssetType, ScanState } from './types.ts';

const SKIP_DIRS = new Set(['_meta', '99_Temp', '99_Trash', '99_Unsorted', '.git', 'node_modules', '.fbm', '00_INBOX', 'renders', 'render']);

const MODEL_EXT = new Set(['.fbx', '.obj', '.glb', '.gltf', '.blend', '.max', '.usdz', '.stl', '.3ds', '.abc']);
const DRAW_EXT = new Set(['.dwg', '.dxf']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp', '.tga', '.psd']);
const IES_EXT = new Set(['.ies']);
const MAP_DIRS = new Set(['maps', 'map', 'textures', 'texture', 'tex']);

interface FileInfo { name: string; ext: string; size: number; mtime: number }
interface SetSpec {
  name: string;
  type: AssetType;
  ext: string;
  previewRel: string | null;
  files: { rel: string; role: string; slot: string | null; size: number; mtime: number }[];
  size: number;
}

const toPosix = (p: string) => p.split(path.sep).join('/');
const stem = (n: string) => n.replace(/\.[^.]+$/, '');
const isImg = (ext: string) => IMG_EXT.has(ext);

function listFiles(absDir: string): FileInfo[] {
  const out: FileInfo[] = [];
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isFile()) continue;
    try {
      const st = fs.statSync(path.join(absDir, e.name));
      out.push({ name: e.name, ext: path.extname(e.name).toLowerCase(), size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch { /* ignore */ }
  }
  return out;
}

function findPreview(files: FileInfo[], name = ''): string | null {
  const isPrev = (f: FileInfo) => /_preview\./i.test(f.name) || /_render\./i.test(f.name) || /preview/i.test(f.name);
  const prev = files.filter(f => (isImg(f.ext) || f.ext === '.pdf') && isPrev(f));
  if (!prev.length) return null;
  if (name) {
    // 先找与素材名同前缀的预览（避免 1k 预览被 4k 素材抢走）
    const exact = prev.find(f => f.name.toLowerCase().startsWith(name.toLowerCase()));
    if (exact) return exact.name;
    // 通用预览（名字里没有分辨率）可以用；带分辨率但不匹配的不要
    const generic = prev.find(f => !/\d+k/i.test(f.name));
    if (generic) return generic.name;
    return null;
  }
  return prev[0]?.name ?? null;
}

function detect(absDir: string, relDir: string, files: FileInfo[], mapFiles: { name: string; size: number; mtime: number }[]): SetSpec[] {
  const out: SetSpec[] = [];
  const dirName = path.basename(absDir);
  const category = relDir.split('/')[0] || '';
  const mtlx = files.filter(f => f.ext === '.mtlx');
  const models = files.filter(f => MODEL_EXT.has(f.ext));
  const drawings = files.filter(f => DRAW_EXT.has(f.ext));
  const hdris = files.filter(f => f.ext === '.exr' || f.ext === '.hdr');
  const iesFiles = files.filter(f => IES_EXT.has(f.ext));
  const images = files.filter(f => isImg(f.ext));

  const base = (main: FileInfo[], role: string, type: AssetType, ext: string, name: string, preview: string | null, siblings = true): SetSpec => {
    const list: SetSpec['files'] = [];
    let size = 0;
    for (const f of main) {
      list.push({ rel: `${relDir}/${f.name}`, role, slot: null, size: f.size, mtime: f.mtime });
      size += f.size;
    }
    if (siblings) for (const f of images) {
      if (preview && f.name === preview) continue;
      if (main.includes(f)) continue;
      list.push({ rel: `${relDir}/${f.name}`, role: 'map', slot: null, size: f.size, mtime: f.mtime });
      size += f.size;
    }
    for (const f of mapFiles) {
      list.push({ rel: `${relDir}/maps/${f.name}`, role: 'map', slot: null, size: f.size, mtime: f.mtime });
      size += f.size;
    }
    if (preview) {
      const pf = files.find(f => f.name === preview);
      list.push({ rel: `${relDir}/${preview}`, role: 'preview', slot: null, size: pf?.size ?? 0, mtime: pf?.mtime ?? 0 });
    }
    return { name, type, ext, previewRel: preview ? `${relDir}/${preview}` : null, files: list, size };
  };

  if (mtlx.length) {
    for (const m of mtlx) {
      out.push(base([m], 'main', 'material', '.mtlx', stem(m.name), findPreview(files, stem(m.name))));
    }
    return out;
  }

  if (models.length) {
    const type: AssetType = relDir.startsWith('06_Scene') ? 'scene' : 'model';
    const spec = base(models, 'model', type, models[0].ext, dirName, findPreview(files, dirName));
    // variants get slots
    let i = 1;
    for (const f of spec.files) if (f.role === 'model') f.slot = String(i++).padStart(2, '0');
    out.push(spec);
    return out;
  }

  if (drawings.length) {
    for (const d of drawings) {
      const sibling = files.find(f => stem(f.name).toLowerCase() === stem(d.name).toLowerCase()
        && (f.ext === '.pdf' || isImg(f.ext)));
      out.push(base([d], 'main', 'drawing', d.ext, stem(d.name), sibling?.name ?? null));
    }
    return out;
  }

  if (hdris.length) {
    for (const h of hdris) {
      out.push(base([h], 'main', 'hdri', h.ext, stem(h.name), findPreview(files, stem(h.name))));
    }
    return out;
  }

  if (iesFiles.length) {
    for (const f of iesFiles) {
      out.push(base([f], 'main', 'ies', f.ext, stem(f.name), null, false));
    }
    return out;
  }

  if (images.length >= 2) {
    const slotRe = /(basecolor|base_color|albedo|diffuse|normal|nrm|rough|metal|occlusion|_ao\b|height|displacement|gloss)/i;
    const hasSlots = images.some(f => slotRe.test(f.name));
    if (hasSlots) {
      out.push(base([], 'map', 'texture', images[0].ext, dirName, findPreview(files, dirName)));
    } else {
      for (const img of images.slice(0, 500)) {
        out.push(base([img], 'map', 'texture', img.ext, stem(img.name), null, false));
      }
    }
    return out;
  }

  if (images.length === 1) {
    const img = images[0];
    out.push(base([img], 'map', 'texture', img.ext, stem(img.name), null, false));
  }
  return out;
}

export const scanState: ScanState = {
  running: false, libraryId: null, scanned: 0, startedAt: null, finishedAt: null, error: null
};

export interface ScanResult { assets: number; files: number; ms: number }

export function scanLibrary(db: DB, libraryId: number, root: string): ScanResult {
  const t0 = Date.now();
  scanState.running = true;
  scanState.libraryId = libraryId;
  scanState.scanned = 0;
  scanState.startedAt = t0;
  scanState.finishedAt = null;
  scanState.error = null;

  const keep = new Map<string, { rating: number; favorite: number; status: string }>();
  for (const r of db.prepare('SELECT rel_dir,name,rating,favorite,status FROM assets WHERE library_id=?').all(libraryId) as any[]) {
    keep.set(`${r.rel_dir}|${r.name}`, { rating: r.rating, favorite: r.favorite, status: r.status });
  }

  db.prepare('DELETE FROM assets WHERE library_id=?').run(libraryId);

  const insAsset = db.prepare(`INSERT INTO assets(library_id,rel_dir,name,type,ext,category,size,rating,favorite,preview_rel,status,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insFile = db.prepare('INSERT INTO files(asset_id,rel_path,role,slot,size,mtime) VALUES(?,?,?,?,?,?)');

  let assetCount = 0, fileCount = 0, dirs = 0;

  const walk = (absDir: string, relDir: string) => {
    dirs++;
    const files = listFiles(absDir);
    const mapFiles: FileInfo[] = [];
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (!MAP_DIRS.has(e.name.toLowerCase())) continue;
      mapFiles.push(...listFiles(path.join(absDir, e.name)));
    }

    const sets = detect(absDir, relDir, files, mapFiles);
    if (sets.length) {
      db.exec('BEGIN');
      try {
        for (const s of sets) {
          if (!s.name) continue;
          const k = `${relDir}|${s.name}`;
          const old = keep.get(k);
          const info = insAsset.run(libraryId, relDir, s.name, s.type, s.ext, relDir.split('/')[0] ?? null,
            s.size, old?.rating ?? 0, old?.favorite ?? 0, s.previewRel, old?.status ?? 'ok', Date.now());
          const assetId = Number(info.lastInsertRowid);
          for (const f of s.files) insFile.run(assetId, f.rel, f.role, f.slot, f.size, f.mtime);
          assetCount++;
          fileCount += s.files.length;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      scanState.scanned = assetCount;
    }

    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const n = e.name;
      if (SKIP_DIRS.has(n) || n.startsWith('.')) continue;
      if (MAP_DIRS.has(n.toLowerCase())) continue;
      walk(path.join(absDir, n), relDir ? `${relDir}/${n}` : n);
    }
  };

  try {
    walk(root, '');
    const ms = Date.now() - t0;
    db.prepare('UPDATE libraries SET last_scan_at=?, scan_ms=?, asset_count=? WHERE id=?')
      .run(Date.now(), ms, assetCount, libraryId);
    scanState.finishedAt = Date.now();
    return { assets: assetCount, files: fileCount, ms };
  } catch (e: any) {
    scanState.error = String(e?.message ?? e);
    throw e;
  } finally {
    scanState.running = false;
  }
}

