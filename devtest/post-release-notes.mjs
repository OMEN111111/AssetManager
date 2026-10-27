// 发布后回填：把远端 main 提交写进 AGENTS.md / Logs（显式 UTF-8）
import fs from 'node:fs';

const SHA = '3c0db13';
const URL = 'https://github.com/OMEN111111/AssetManager/releases/tag/v0.5.0';

// 1) AGENTS.md
let a = fs.readFileSync('AGENTS.md', 'utf8');
a = a.replace(
  '- 已发布版本：**0.5.0**（2026-10-26）\n  - Release：' + URL + '\n  - 附件：`AssetManager-Setup-0.5.0.exe`、`AssetManager-0.5.0.exe`、`AssetManager-0.5.0-source.zip`、`SHA256SUMS.txt`',
  '- 已发布版本：**0.5.0**（2026-10-26）\n  - Release：' + URL + '\n  - 附件：`AssetManager-Setup-0.5.0.exe`、`AssetManager-0.5.0.exe`、`AssetManager-0.5.0-source.zip`、`SHA256SUMS.txt`\n  - 远端 main 提交：`' + SHA + '`（tag `v0.5.0` 指向同一提交，仓库 131 个文件、不含 Logs/docs/AGENTS.md）'
);
a = a.replace('- 远端 `main`：`afff7ea`；本地历史与远端**分叉**，不要直接 `git push`。',
  '- 远端 `main`：`' + SHA + '`；本地历史与远端**分叉**，不要直接 `git push`。');
a = a.replace('- 当前远端 main：`afff7ea`（只含代码与插件），`v0.4.12` tag 与 Release 源码包指向同一提交。',
  '- 当前远端 main：`' + SHA + '`（只含代码与插件），`v0.5.0` tag 与 Release 源码包指向同一提交。');
fs.writeFileSync('AGENTS.md', a, 'utf8');

// 2) Logs/软件版本更新.md：0.5.0 一节补提交号
let v = fs.readFileSync('Logs/软件版本更新.md', 'utf8');
v = v.replace('- Release：' + URL, '- 远端 main 提交：`' + SHA + '`\n- Release：' + URL);
fs.writeFileSync('Logs/软件版本更新.md', v, 'utf8');

// 3) Logs/本地存档记录.md：追加发布记录
let l = fs.readFileSync('Logs/本地存档记录.md', 'utf8');
l = l.replace(/\n*$/, '\n') +
  '- **22:5x** · **发布 v0.5.0** — ' + URL + '（免安装 / 安装版 / 源码包 / SHA256SUMS 四个附件；远端 main `' + SHA + '`，仓库只含代码与插件）\n';
fs.writeFileSync('Logs/本地存档记录.md', l, 'utf8');

console.log('回填完成');
console.log('AGENTS 含 3c0db13:', (fs.readFileSync('AGENTS.md', 'utf8').match(new RegExp(SHA, 'g')) || []).length, '处');
