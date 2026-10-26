// 往某个 Logs 文件末尾追加一行（显式 UTF-8，避免 PowerShell 编码坑）
import fs from 'node:fs';
const [file, text] = process.argv.slice(2);
if (!file || !text) { console.error('用法: node devtest/append-log.mjs <文件> "<行内容>"'); process.exit(1); }
const t = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, t.replace(/\n*$/, '\n') + text + '\n', 'utf8');
console.log('已追加 →', file, '| 现在', Buffer.byteLength(fs.readFileSync(file, 'utf8')), 'bytes');
