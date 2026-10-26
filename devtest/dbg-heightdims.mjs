import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync('app/data/library.db', { readOnly: true });
const root = db.prepare('select root from libraries limit 1').get().root;
const rows = db.prepare(`select f.rel_path, a.name asset from files f join assets a on a.id=f.asset_id
  where lower(f.rel_path) like '%height%' or lower(f.rel_path) like '%disp%' or lower(f.rel_path) like '%_bump%'`).all();

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

let n = 0;
const bad = [];
for (const r of rows) {
  const abs = path.join(root, r.rel_path);
  if (!fs.existsSync(abs)) { bad.push(r.rel_path + ' (missing)'); continue; }
  const head = fs.readFileSync(abs).subarray(0, 65536);
  const size = head[0] === 0x89 ? pngSize(fs.readFileSync(abs)) : jpegSize(head);
  n++;
  const aspect = size ? +(size.w / size.h).toFixed(3) : 0;
  if (!size || Math.abs(aspect - 1) > 0.01) console.log('NON-SQUARE', r.rel_path, JSON.stringify(size), 'aspect', aspect);
}
console.log(`共 ${rows.length} 条 height/disp 文件，检查 ${n} 张；非方形/缺失 ${bad.length + 0}`);
if (bad.length) console.log(bad.join('\n'));
