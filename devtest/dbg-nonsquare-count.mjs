import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync('app/data/library.db', { readOnly: true });
const root = db.prepare('select root from libraries limit 1').get().root;

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
const cache = new Map();
function dims(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const abs = path.join(root, rel);
  let s = null;
  if (fs.existsSync(abs)) {
    const head = fs.readFileSync(abs).subarray(0, 65536);
    s = head[0] === 0x89 ? pngSize(fs.readFileSync(abs)) : jpegSize(head);
  }
  cache.set(rel, s);
  return s;
}

// 只看材质类素材（路径 02_Materials/…），按「目录 = 一套贴图」归组
const files = db.prepare(`select f.rel_path, a.name asset, a.rel_dir from files f join assets a on a.id=f.asset_id
  where a.rel_dir like '02_Materials/%'`).all();
const byAsset = new Map();
for (const f of files) {
  if (!byAsset.has(f.rel_dir)) byAsset.set(f.rel_dir, []);
  byAsset.get(f.rel_dir).push(f.rel_path);
}
const L = (s) => s.toLowerCase();
let setsWithHeight = 0, nonSquare = 0;
const rows = [];
for (const [dir, list] of byAsset) {
  const h = list.find(p => /height|displacement|_disp|disp_/.test(L(p)) && !/normal|nor_|rough|metal|ao|diff|albedo|col|mask|opacity|spec/.test(L(p)));
  if (!h) continue;
  setsWithHeight++;
  const d = dims(h);
  if (!d) continue;
  if (d.w !== d.h) {
    nonSquare++;
    const base = list.find(p => /basecolor|base_color|albedo|diffuse|_diff|_col/.test(L(p)));
    const bd = base ? dims(base) : null;
    rows.push({ dir, height: path.basename(h), size: `${d.w}x${d.h}`, aspect: d.w / d.h, base: base ? path.basename(base) : '-', baseSize: bd ? `${bd.w}x${bd.h}` : '-' });
  }
}
console.log(`材质集 ${byAsset.size} 个，其中带高度/置换图的 ${setsWithHeight} 个；高度图非方形的 ${nonSquare} 个`);
for (const r of rows) console.log(`  ${r.dir}\n    height ${r.height} ${r.size} (重复 ${r.aspect}×)   base ${r.base} ${r.baseSize}`);
