#!/usr/bin/env node
// 3ds Max 插件系列同步：以「最新系列目录」（2027/）为唯一真源，同步到其它系列目录。
//   node tools/sync-max-bridge.mjs          # 写入其它系列
//   node tools/sync-max-bridge.mjs --check  # 只检查，不一致则退出码 1（提交前跑）
// 某系列确实需要分叉时，在该系列文件头部写 `-- SYNC: skip`。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FILE_PREFIX = 'AssetManagerBridge';
const pickFile = dir => fs.readdirSync(dir).find(f => f.startsWith(FILE_PREFIX) && f.endsWith('.ms'));
const checkOnly = process.argv.includes('--check');

const series = fs.readdirSync(root, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
  .map(e => e.name)
  .sort((a, b) => Number(a) - Number(b));
if (!series.length) { console.error('找不到任何系列目录（2026/ 2027/ …）'); process.exit(1); }

const canonical = series[series.length - 1];
const canonicalFile = pickFile(path.join(root, canonical));
const canonicalPath = path.join(root, canonical, canonicalFile);
const canonicalSrc = fs.readFileSync(canonicalPath, 'utf8');
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

console.log(`canonical = ${canonical}/${canonicalFile} (${sha(canonicalSrc)})`);
let bad = 0;
for (const v of series) {
  if (v === canonical) continue;
  const dirV = path.join(root, v);
  const curName = pickFile(dirV);
  // 系列目录里还没有 .ms（新建系列）时直接写入 canonical，并清掉其它命名的旧文件
  if (!curName) {
    fs.writeFileSync(path.join(dirV, canonicalFile), canonicalSrc, 'utf8');
    console.log(`created   ${v}/${canonicalFile}`);
    bad++;
    continue;
  }
  const p = path.join(dirV, curName);
  const cur = fs.readFileSync(p, 'utf8');
  if (cur.includes('-- SYNC: skip')) { console.log(`skip      ${v}/ （标记了 SYNC: skip）`); continue; }
  if (sha(cur) === sha(canonicalSrc)) { console.log(`same      ${v}/`); continue; }
  bad++;
  if (checkOnly) { console.log(`DIFFER    ${v}/ 与 ${canonical}/ 不一致（sha=${sha(cur)}）`); continue; }
  fs.writeFileSync(path.join(dirV, canonicalFile), canonicalSrc, 'utf8');
  if (curName !== canonicalFile) {
    fs.unlinkSync(p);
    console.log(`renamed   ${v}/${curName} -> ${canonicalFile}`);
  } else {
    console.log(`synced    ${v}/ <- ${canonical}/`);
  }
}
if (!checkOnly) console.log('\n完成。');
if (checkOnly && bad) { console.error(`\n${bad} 个系列与 canonical 不一致`); process.exit(1); }
