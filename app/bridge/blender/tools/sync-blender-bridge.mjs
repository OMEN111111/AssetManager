#!/usr/bin/env node
/**
 * Blender 桥接插件·系列同步工具
 *
 * 各 Blender 系列目录（3.6 / 4.0 / …）里的插件共用同一份实现主体，只有文件头部
 * （bl_info、BL_VERSION、BL_SERIES）按系列不同。改动实现时改一份，然后用本工具同步：
 *
 *   node tools/sync-blender-bridge.mjs            # 以最高系列（如 4.0）为主体，同步到其他系列
 *   node tools/sync-blender-bridge.mjs --from 3.6  # 指定主体系列
 *   node tools/sync-blender-bridge.mjs --check     # 只检查是否已同步（CI / 提交前用）
 *
 * 系列之间真的需要分叉时（例如 4.2+ 的扩展格式、5.0 的 API 变化），把该系列从同步
 * 列表里去掉即可：在它的文件头部写上 `# SYNC: skip`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'assetmanager_blender.py';
const MARKER = '# >>> AM_BODY >>>';

const args = process.argv.slice(2);
const check = args.includes('--check');
const fromArg = (() => {
  const i = args.indexOf('--from');
  return i >= 0 ? args[i + 1] : null;
})();

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

const seriesDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d+\.\d+$/.test(d.name))
  .map(d => d.name)
  .sort(cmp);

if (!seriesDirs.length) {
  console.error('✘ 没找到系列目录（形如 3.6 / 4.0）');
  process.exit(1);
}

function read(series) {
  const file = path.join(ROOT, series, FILE);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf(MARKER);
  if (at < 0) {
    console.error(`✘ ${series}/${FILE} 缺少主体标记行「${MARKER}」`);
    process.exit(1);
  }
  const eol = text.slice(0, at).lastIndexOf('\n') + 1;
  return { file, header: text.slice(0, eol), body: text.slice(eol), skip: /#\s*SYNC:\s*skip/i.test(text.slice(0, at)) };
}

const files = new Map();
for (const s of seriesDirs) {
  const f = read(s);
  if (!f) {
    console.error(`✘ 缺少 ${s}/${FILE}`);
    process.exit(1);
  }
  files.set(s, f);
}

const source = fromArg || [...files.keys()].reverse().find(s => !files.get(s).skip);
if (!files.has(source)) {
  console.error(`✘ 指定的主体系列不存在：${source}`);
  process.exit(1);
}
const src = files.get(source);

const versions = new Map();
for (const [s, f] of files) {
  const m = f.header.match(/BL_VERSION\s*=\s*"([^"]+)"/);
  versions.set(s, m ? m[1] : '?');
}
const versionSet = new Set(versions.values());
if (versionSet.size > 1) {
  console.warn(`⚠ 各系列插件版本不一致：${[...versions].map(([s, v]) => `${s}=${v}`).join('，')}`);
  console.warn('  约定是所有系列共用同一个插件版本号，改完请统一。');
}

let drift = 0;
for (const [s, f] of files) {
  if (s === source || f.skip) continue;
  if (f.body === src.body) {
    console.log(`✔ ${s} 已同步（v${versions.get(s)}）`);
    continue;
  }
  drift++;
  if (check) {
    console.error(`✘ ${s} 的实现主体与 ${source} 不一致（v${versions.get(s)}）`);
    continue;
  }
  fs.writeFileSync(f.file, f.header + src.body, 'utf8');
  console.log(`✎ ${s} 已按 ${source} 同步（v${versions.get(s)}）`);
}

if (check) {
  if (drift) {
    console.error(`\n共 ${drift} 个系列未同步：运行 node tools/sync-blender-bridge.mjs`);
    process.exit(1);
  }
  console.log('\n全部系列已同步。');
} else {
  console.log(`\n主体：${source} · 系列：${seriesDirs.join(' / ')} · 插件版本：${[...versionSet].join(' / ')}`);
}
