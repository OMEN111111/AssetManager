#!/usr/bin/env node
/**
 * Maya 桥接插件 · 系列同步工具
 *
 * 各 Maya 系列目录（2025 / 2026 / 2027 …）里的插件共用同一份实现主体，只有文件头部
 * （AM_PLUGIN_VERSION / AM_SERIES 与说明文字）按系列不同。改实现时改一份，然后同步：
 *
 *   node tools/sync-maya-bridge.mjs              # 以最新系列（2025）为主体，同步到其他系列
 *   node tools/sync-maya-bridge.mjs --from 2025  # 指定主体系列
 *   node tools/sync-maya-bridge.mjs --check      # 只检查是否已同步（提交前用）
 *
 * 系列之间真要分叉时（例如某个 Maya 版本 API 变了），在该系列文件头部写 `# SYNC: skip`，
 * 它就不会被覆盖。
 *
 * 同步范围：<系列>/scripts/assetmanager_maya.py 的主体部分 + scripts/userSetup.py。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join('scripts', 'assetmanager_maya.py');
const SETUP = path.join('scripts', 'userSetup.py');
const MARKER = '# >>> AM_BODY >>>';

const args = process.argv.slice(2);
const check = args.includes('--check');
const fromArg = (() => {
  const i = args.indexOf('--from');
  return i >= 0 ? args[i + 1] : null;
})();

/** 系列目录名是年份（2025 / 2026 …），按数字排 */
const seriesDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name))
  .map(d => d.name)
  .sort((a, b) => Number(a) - Number(b));

if (!seriesDirs.length) {
  console.error('✘ 没找到系列目录（形如 2025 / 2026）');
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

// 开发/测试都在最新的系列里做，然后同步出去
const CANONICAL = seriesDirs[seriesDirs.length - 1];
const from = fromArg || CANONICAL;
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
  const curVersion = (cur.header.match(/AM_PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '';
  const wantSeries = (cur.header.match(/AM_SERIES\s*=\s*"([^"]+)"/) || [])[1] || series;
  const versionOk = curVersion === version;

  if (sameBody && versionOk) {
    console.log(`✔ ${series}: 已同步（v${curVersion}）`);
    continue;
  }

  if (check) {
    console.log(`✘ ${series}: ${!sameBody ? '主体不一致' : ''}${!versionOk ? ` 版本 ${curVersion} ≠ ${version}` : ''}`);
    dirty++;
    continue;
  }

  // 只换头部里的版本号，其余头部（系列说明、AM_SERIES）保持该系列自己的
  let header = cur.header.replace(/AM_PLUGIN_VERSION\s*=\s*"[^"]+"/, `AM_PLUGIN_VERSION = "${version}"`);
  if (!/AM_SERIES\s*=\s*"/.test(header)) header = header.replace(/^(AM_PLUGIN_VERSION.*)$/m, `$1\nAM_SERIES = "${wantSeries}"`);
  fs.writeFileSync(cur.file, header + src.body, 'utf8');
  console.log(`→ ${series}: 已同步（v${version}）`);

  // userSetup.py 各系列一致（只有里面的版本号跟着主体走）
  const srcSetup = path.join(ROOT, from, SETUP);
  const dstSetup = path.join(ROOT, series, SETUP);
  if (fs.existsSync(srcSetup)) {
    let want = fs.readFileSync(srcSetup, 'utf8');
    // 目标系列若有自己的版本号，保留它（防止两处不一致）
    if (fs.existsSync(dstSetup)) {
      const oldVer = (fs.readFileSync(dstSetup, 'utf8').match(/AM_PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1];
      const newVer = (want.match(/AM_PLUGIN_VERSION\s*=\s*"([^"]+)"/) || [])[1];
      if (oldVer && newVer && oldVer !== newVer) {
        want = want.replace(/AM_PLUGIN_VERSION\s*=\s*"[^"]+"/, `AM_PLUGIN_VERSION = "${oldVer}"`);
      }
    }
    if (!fs.existsSync(dstSetup) || fs.readFileSync(dstSetup, 'utf8') !== want) {
      fs.writeFileSync(dstSetup, want, 'utf8');
    }
  }
}

if (check && dirty) {
  console.error(`\n✘ ${dirty} 个系列未同步：node tools/sync-maya-bridge.mjs 同步一下`);
  process.exit(1);
}
console.log(check ? '✔ 全部已同步' : '✔ 同步完成');
