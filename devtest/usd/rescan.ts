/**
 * 重扫当前库（改了 scan.ts 的规则后用；USD 资产会从 texture 变成 model）。
 *
 * 用法（在仓库根目录）：
 *   npx --yes tsx devtest/usd/rescan.ts
 * 数据目录默认 app/data；打包版的数据目录是 %APPDATA%\assetmanager-app，用 AM_DATA 指过去。
 */
import path from 'node:path';
import { openDb, listLibraries } from '../../app/src/core/db.ts';
import { scanLibrary } from '../../app/src/core/scan.ts';

const dataDir = process.env.AM_DATA ? path.resolve(process.env.AM_DATA) : path.resolve('app/data');
const db = openDb(path.join(dataDir, 'library.db'));
console.log('数据目录:', dataDir);

for (const l of listLibraries(db) as any[]) {
  const t0 = Date.now();
  const r = scanLibrary(db, Number(l.id), String(l.root));
  console.log(`${l.name} (${l.root}) ->`, JSON.stringify(r), Date.now() - t0 + 'ms');
}

const usd = db.prepare(`SELECT id, name, type, ext, rel_dir FROM assets
  WHERE lower(ext) IN ('.usd', '.usda', '.usdc', '.usdz') ORDER BY id`).all() as any[];
console.log(`\nUSD 素材 ${usd.length} 个：`);
for (const r of usd) console.log(' ', r.id, r.type, r.ext, `${r.rel_dir}/${r.name}`);
