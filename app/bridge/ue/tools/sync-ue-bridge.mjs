#!/usr/bin/env node
/**
 * UE 桥接插件 · 系列同步工具
 *
 * 各引擎系列目录（5.6 / 5.7 / 5.8 …）里的插件共用同一份实现主体，只有文件头部
 * （AM_PLUGIN_VERSION / AM_SERIES 与说明文字）按系列不同。改实现时改一份，然后同步：
 *
 *   node tools/sync-ue-bridge.mjs              # 以 5.7（CANONICAL）为主体，同步到其他系列
 *   node tools/sync-ue-bridge.mjs --from 5.7   # 指定主体系列
 *   node tools/sync-ue-bridge.mjs --check      # 只检查是否已同步（提交前用）
 *
 * 系列之间真要分叉时（例如某个引擎版本 API 变了），在该系列文件头部写 `# SYNC: skip`，
 * 它就不会被覆盖。
 *
 * 同步范围：<系列>/AssetManagerBridge/Content/Python/assetmanager_ue.py 的主体部分。
 * init_unreal.py 与 .uplugin 由本工具一并按主体系列覆盖（只改 .uplugin 的 VersionName/Version）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'AssetManagerBridge';
const PY = path.join(PLUGIN, 'Content', 'Python', 'assetmanager_ue.py');
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
  console.error('✘ 没找到系列目录（形如 5.7 / 5.8）');
  process.exit(1);
}

function read(series) {
  const file = path.join(ROOT, series, PY);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf(MARKER);
  if (at < 0) {
    console.error(`✘ ${series}/${PY} 缺少主体标记行「${MARKER}」`);
    process.exit(1);
  }
  const eol = text.slice(0, at).lastIndexOf('\n') + 1;
  return {
    file,
    header: text.slice(0, eol),
    body: text.slice(eol),
    skip: /#\s*SYNC:\s*skip/i.test(text.slice(0, at))
  };
}

const CANONICAL = '5.7';   // 开发/测试都在这个系列里做，然后同步出去
const from = fromArg || (seriesDirs.includes(CANONICAL) ? CANONICAL : seriesDirs[seriesDirs.length - 1]);
const src = read(from);
if (!src) {
  console.error(`✘ 主体系列 ${from} 不存在（或缺少 ${PY}）`);
  process.exit(1);
}
if (src.skip) {
  console.error(`✘ 主体系列 ${from} 标了 SYNC: skip，不能当主体`);
  process.exit(1);
}

const version = (src.header.match(/AM_PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '';
console.log(`主体：${from}（插件 v${version}），系列：${seriesDirs.join(' / ')}`);

let dirty = 0;
for (const series of seriesDirs) {
  if (series === from) continue;
  const cur = read(series);
  if (!cur) { console.log(`- ${series}: 跳过（没有 ${PY}）`); continue; }
  if (cur.skip) { console.log(`- ${series}: 标了 SYNC: skip，跳过`); continue; }

  const sameBody = cur.body === src.body;
  const wantVersion = version;
  const curVersion = (cur.header.match(/AM_PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '';
  const wantSeries = (cur.header.match(/AM_SERIES\s*=\s*"([^"]+)"/) || [])[1] || series;
  const versionOk = curVersion === wantVersion;

  if (sameBody && versionOk) {
    console.log(`✔ ${series}: 已同步（v${curVersion}）`);
    continue;
  }

  if (check) {
    console.log(`✘ ${series}: ${!sameBody ? '主体不一致' : ''}${!versionOk ? ` 版本 ${curVersion} ≠ ${wantVersion}` : ''}`);
    dirty++;
    continue;
  }

  // 只换头部里的版本号，其余头部（系列说明、AM_SERIES）保持该系列自己的
  let header = cur.header.replace(/AM_PLUGIN_VERSION\s*=\s*"[^"]+"/, `AM_PLUGIN_VERSION = "${wantVersion}"`);
  if (!/AM_SERIES\s*=\s*"/.test(header)) header = header.replace(/^(AM_PLUGIN_VERSION.*)$/m, `$1\nAM_SERIES = "${wantSeries}"`);
  fs.writeFileSync(cur.file, header + src.body, 'utf8');
  console.log(`→ ${series}: 已同步（v${wantVersion}）`);

  // .uplugin 的版本号跟着主体走（其余字段各系列一致，直接以主体为准）
  const srcUplugin = path.join(ROOT, from, PLUGIN, `${PLUGIN}.uplugin`);
  const dstUplugin = path.join(ROOT, series, PLUGIN, `${PLUGIN}.uplugin`);
  if (fs.existsSync(srcUplugin) && fs.existsSync(dstUplugin)) {
    const want = fs.readFileSync(srcUplugin, 'utf8');
    if (fs.readFileSync(dstUplugin, 'utf8') !== want) fs.writeFileSync(dstUplugin, want, 'utf8');
  }
  // init_unreal.py 各系列一致
  const srcInit = path.join(ROOT, from, PLUGIN, 'Content', 'Python', 'init_unreal.py');
  const dstInit = path.join(ROOT, series, PLUGIN, 'Content', 'Python', 'init_unreal.py');
  if (fs.existsSync(srcInit) && fs.existsSync(dstInit)) {
    const want = fs.readFileSync(srcInit, 'utf8');
    if (fs.readFileSync(dstInit, 'utf8') !== want) fs.writeFileSync(dstInit, want, 'utf8');
  }
}

if (check && dirty) {
  console.error(`\n✘ ${dirty} 个系列未同步：node tools/sync-ue-bridge.mjs 同步一下`);
  process.exit(1);
}
console.log(check ? '✔ 全部已同步' : '✔ 同步完成');

