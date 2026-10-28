// SketchUp 插件系列同步：main.rb 只有一份（2026 = canonical），其余系列共用同一份实现
// 各系列不同的只有加载器 assetmanager_su.rb 里的 AM_SERIES 与注释
//
// 用法：
//   node tools/sync-su-bridge.mjs           # 把 canonical 的 main.rb 同步到所有系列
//   node tools/sync-su-bridge.mjs --check   # 只检查（CI / 提交前跑）
//   node tools/sync-su-bridge.mjs --new 2028  # 新建一个系列（拷 loader + 改 AM_SERIES）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = '2026';
const LOADER = 'assetmanager_su.rb';
const MAIN_DIR = 'assetmanager_su';
const MAIN = 'main.rb';
const checkOnly = process.argv.includes('--check');
const newIdx = process.argv.indexOf('--new');
const newSeries = newIdx >= 0 ? process.argv[newIdx + 1] : null;

function seriesDirs() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name)
    .sort();
}

function readMain(series) {
  return fs.readFileSync(path.join(ROOT, series, MAIN_DIR, MAIN), 'utf8');
}

// 新建系列：拷 canonical 的 loader 与实现，把 AM_SERIES / 注释里的年份换掉
if (newSeries) {
  if (!/^\d{4}$/.test(newSeries)) { console.error('系列名要是四位年份'); process.exit(1); }
  const dst = path.join(ROOT, newSeries);
  if (fs.existsSync(dst)) { console.error(`${newSeries} 已存在`); process.exit(1); }
  fs.mkdirSync(path.join(dst, MAIN_DIR), { recursive: true });
  const short = String(Number(newSeries) - 2000);
  let loader = fs.readFileSync(path.join(ROOT, CANONICAL, LOADER), 'utf8');
  loader = loader
    .replace(/AM_SERIES = '\d{4}'/, `AM_SERIES = '${newSeries}'`)
    .replace(/· \d{4} 系列（SketchUp \d{4} \/ \d+\.x）/, `· ${newSeries} 系列（SketchUp ${newSeries} / ${short}.x）`)
    .replace(/SketchUp \d{4}(\\SketchUp)/, `SketchUp ${newSeries}$1`);
  fs.writeFileSync(path.join(dst, LOADER), loader, 'utf8');
  fs.copyFileSync(path.join(ROOT, CANONICAL, MAIN_DIR, MAIN), path.join(dst, MAIN_DIR, MAIN));
  console.log(`已新建系列 ${newSeries}/（loader 的 AM_SERIES=${newSeries}，实现与 ${CANONICAL} 一致）`);
  process.exit(0);
}

const all = seriesDirs();
if (!all.includes(CANONICAL)) { console.error(`缺少 canonical 系列 ${CANONICAL}`); process.exit(1); }
const canon = readMain(CANONICAL);
let bad = 0;

for (const s of all) {
  if (s === CANONICAL) continue;
  const p = path.join(ROOT, s, MAIN_DIR, MAIN);
  if (!fs.existsSync(p)) { console.log(`  ${s}: 缺 ${MAIN_DIR}/${MAIN}`); bad++; continue; }
  const cur = fs.readFileSync(p, 'utf8');
  if (cur === canon) { console.log(`  ${s}: 已同步`); continue; }
  if (checkOnly) { console.log(`  ${s}: **与 ${CANONICAL} 不一致**`); bad++; continue; }
  fs.writeFileSync(p, canon, 'utf8');
  console.log(`  ${s}: 已从 ${CANONICAL} 同步（${cur.length} → ${canon.length} 字节）`);
}

// 顺手检查每个 loader 的 AM_SERIES 与目录名一致
for (const s of all) {
  const loaderPath = path.join(ROOT, s, LOADER);
  if (!fs.existsSync(loaderPath)) { console.log(`  ${s}: 缺 ${LOADER}`); bad++; continue; }
  const m = fs.readFileSync(loaderPath, 'utf8').match(/AM_SERIES\s*=\s*'(\d{4})'/);
  if (!m) { console.log(`  ${s}: loader 里没有 AM_SERIES`); bad++; continue; }
  if (m[1] !== s) { console.log(`  ${s}: loader 的 AM_SERIES=${m[1]} 与目录名不符`); bad++; }
}

console.log(bad === 0 ? `\n系列 ${all.join(' / ')}：全部一致（canonical = ${CANONICAL}）` : `\n有 ${bad} 处问题`);
process.exit(bad === 0 ? 0 : 1);
