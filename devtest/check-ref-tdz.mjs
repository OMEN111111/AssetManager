// 检查渲染端「X.current = ...」是否写在 const X = useRef(...) 之前（TDZ 运行时报错）
import fs from 'node:fs';
import path from 'node:path';
const dir = 'app/src/renderer';
let bad = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.tsx') || x.endsWith('.ts'))) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  const decl = new Map();
  lines.forEach((l, i) => {
    const m = /const (\w+) = useRef/.exec(l);
    if (m && !decl.has(m[1])) decl.set(m[1], i + 1);
  });
  lines.forEach((l, i) => {
    const m = /^\s*(\w+)\.current\s*=/.exec(l);
    if (!m) return;
    const d = decl.get(m[1]);
    if (d && d > i + 1) { console.log(`${f}:${i + 1}  ${m[1]}.current 赋值早于第 ${d} 行的声明`); bad++; }
  });
}
console.log(bad ? `发现 ${bad} 处 TDZ 风险` : 'TDZ 检查通过');
process.exit(bad ? 1 : 0);
