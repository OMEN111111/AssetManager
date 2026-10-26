// 把 app/package.json 的版本号改成参数给的版本
import fs from 'node:fs';
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('用法: node devtest/bump-version.mjs 0.5.0'); process.exit(1); }
const p = 'app/package.json';
const t = fs.readFileSync(p, 'utf8');
const next = t.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${v}$2`);
if (next === t) { console.error('没找到版本号或已是目标版本'); process.exit(1); }
fs.writeFileSync(p, next, 'utf8');
console.log('版本 →', v, '|', next.split('\n').find(l => l.includes('"version"')));
