/**
 * 离线组合自测：不启服务、不开浏览器，直接在 Node 里跑
 *   app/src/renderer/usd/ 里的解析/组合（贴图用假的 Image 立即"加载"）。
 * 目的：验证 references / payload / over / 变体 / 材质绑定 / ORM / 贴图路径 都对。
 *
 * 用法：node devtest/usd/compose.mjs "F:/02AssetLibrary/Asset/05_Models/Appliance/BeverageStation_001/BeverageStation_001.usd"
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve('app/src/renderer/usd');
const { USDAParser } = await import(pathToFileURL(path.join(ROOT, 'USDAParser.js')).href);
const { USDCParser } = await import(pathToFileURL(path.join(ROOT, 'USDCParser.js')).href);
const { USDComposer } = await import(pathToFileURL(path.join(ROOT, 'USDComposer.js')).href);

// --- 假 Image ---------------------------------------------------------------
const loaded = [];
const missing = [];
globalThis.Image = class FakeImage {
  constructor() { this.width = 1024; this.height = 1024; this.naturalWidth = 1024; this.naturalHeight = 1024; }
  set src(v) {
    this._src = v;
    let file = null;
    try { file = v.startsWith('file://') ? fileURLToPath(v) : v; } catch { file = null; }
    const ok = file && fs.existsSync(file) && fs.statSync(file).isFile();
    if (ok) loaded.push(path.basename(file)); else missing.push(v);
    // 异步回调，模拟真实加载
    setTimeout(() => (ok ? this.onload?.() : this.onerror?.()), 0);
  }
  get src() { return this._src; }
};

const userArgs = process.argv.slice(2);
if (!userArgs.length) { console.error('缺少 USD 文件路径'); process.exit(2); }

const parseLayer = (buf) => (buf.slice(0, 8).toString('latin1') === 'PXR-USDC'
  ? new USDCParser().parseData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  : new USDAParser().parseData(buf.toString('utf8')));

const isLayer = (p) => /\.(usd|usda|usdc)$/i.test(p);

function collectRefs(parsed) {
  const out = [];
  for (const key in parsed.specsByPath || {}) {
    const f = parsed.specsByPath[key].fields || {};
    for (const bucket of [f.references, f.payload]) {
      if (!bucket) continue;
      for (const v of (Array.isArray(bucket) ? bucket : [bucket])) {
        if (typeof v === 'string') { const m = v.match(/@([^@]+)@/); if (m) out.push(m[1]); }
        else if (v && v.assetPath) out.push(String(v.assetPath));
      }
    }
  }
  return out;
}

const resolveRefPath = (ref, base) => {
  let p = String(ref).trim();
  if (p.startsWith('./')) p = p.slice(2);
  return base + p;
};
const dirOf = (u) => u.slice(0, u.lastIndexOf('/') + 1);
const toFileUrl = (p) => pathToFileURL(path.resolve(p)).href;

const t0 = Date.now();
const rootFile = path.resolve(userArgs[0]);
const basePath = dirOf(toFileUrl(rootFile));
const parsedRoot = parseLayer(fs.readFileSync(rootFile));

const assets = {};
const seen = new Set();
const queue = [];
const pushChildren = (parsed, fromUrl, depth) => {
  for (const ref of collectRefs(parsed)) {
    if (!isLayer(ref)) { continue; }
    const url = resolveRefPath(ref, dirOf(fromUrl));
    if (seen.has(url)) continue;
    seen.add(url);
    queue.push({ url, depth });
  }
};
pushChildren(parsedRoot, toFileUrl(rootFile), 1);

let unresolved = [];
while (queue.length) {
  const batch = queue.splice(0, queue.length);
  for (const { url, depth } of batch) {
    if (depth > 6) continue;
    let buf;
    try { buf = fs.readFileSync(fileURLToPath(url)); } catch { unresolved.push(url); continue; }
    const parsed = parseLayer(buf);
    assets[url] = parsed;
    pushChildren(parsed, url, depth + 1);
  }
}

const composer = new USDComposer(null);
const group = composer.compose(parsedRoot, assets, {}, basePath);
await Promise.all(composer.texturePromises || []);

console.log('ms           ', Date.now() - t0);
console.log('layers       ', Object.keys(assets).length);
if (unresolved.length) console.log('unresolved   ', unresolved);
let meshes = 0, tris = 0;
const mats = new Map();
group.traverse((o) => {
  if (!o.isMesh) return;
  meshes++;
  const g = o.geometry;
  tris += (g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3;
  for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (!m) continue;
    const entry = mats.get(m.name || m.uuid) || { name: m.name, map: [], missing: [], color: m.color?.getHexString?.(), rough: m.roughness, metal: m.metalness };
    const put = (slot, t) => {
      if (!t) return;
      entry.map.push(slot + '=' + String(t.image?.src || '').split('/').pop() + (t.image ? '' : '(MISSING)'));
    };
    put('alb', m.map); put('nor', m.normalMap); put('rough', m.roughnessMap);
    put('metal', m.metalnessMap); put('ao', m.aoMap); put('emi', m.emissiveMap);
    entry.repeat = m.map ? m.map.repeat.toArray().join(',') : '';
    entry.normalScale = m.normalScale ? m.normalScale.toArray().join(',') : '';
    mats.set(m.name || m.uuid, entry);
  }
});
console.log('meshes       ', meshes, 'triangles', Math.round(tris));
console.log('materials    ', mats.size);
for (const m of mats.values()) {
  console.log(' -', m.name, '|', m.map.join(' '), '| repeat', m.repeat, '| nScale', m.normalScale);
}
console.log('textures ok  ', [...new Set(loaded)].length, [...new Set(loaded)]);
if (missing.length) console.log('textures MISSING', [...new Set(missing)]);
