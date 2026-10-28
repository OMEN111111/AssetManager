/**
 * USD / USDA / USDC / USDZ → three 场景
 *
 * three 自带 USDLoader 只够看「单层 + 内嵌贴图」的 usdz；真实资产（Omniverse / Isaac Sim /
 * Houdini 导出的 .usd）是「根层 references/payload 到 payloads/*.usda + 独立的 Textures/ 目录」，
 * 原版直接组合出空场景。这里做三件事：
 *
 *  1. 自己把根层读进来，递归抓它 references / payload 指向的其它层（txt 与 crate 都认），
 *     预解析后交给 USDComposer 当「assets」表 —— 组合语义交给 composer；
 *  2. 所有相对路径按 `/api/assetsrc/<assetId>/...` 取（服务端按素材目录解析，含 ../Textures）；
 *  3. 组合完等全部贴图落地，并把「网格/材质/贴图/缺失贴图」统计出来给界面与自测用。
 *
 * 材质不串、贴图不丢的关键都在 USDComposer 的补丁里（见 devtest/usd/make-vendor.mjs）。
 */
import * as THREE from 'three';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
// @ts-ignore 生成文件（devtest/usd/make-vendor.mjs）
import { USDAParser } from './USDAParser.js';
// @ts-ignore
import { USDCParser } from './USDCParser.js';
// @ts-ignore
import { USDComposer } from './USDComposer.js';

export const USD_EXT_RE = /\.(usd|usda|usdc|usdz)$/i;
export const isUsdPath = (p: string) => USD_EXT_RE.test(String(p || ''));

const IMG_EXT_RE = /\.(png|jpe?g|webp|bmp|tga|tiff?|exr|hdr)$/i;
const LAYER_EXT_RE = /\.(usd|usda|usdc)$/i;

export interface UsdLoadArgs {
  /** 素材 id（服务端按它定位素材目录） */
  assetId: number;
  /** 根层文件 id（走 /api/file/:id） */
  fileId: number;
  /** 根层 rel_path（相对素材库根） */
  relPath: string;
  /** 素材的 rel_dir（相对素材库根） */
  assetRelDir: string;
  onStatus?: (msg: string) => void;
  /** 最多抓多少层（防止病态资产把界面拖死） */
  maxLayers?: number;
}

export interface UsdStats {
  meshes: number;
  triangles: number;
  materials: { name: string; maps: string[]; missing: string[] }[];
  textures: string[];
  missingTextures: string[];
  layers: string[];
  /** 组合阶段没解析到的引用（缺文件/外部绝对路径） */
  unresolved: string[];
}

const enc = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** 素材目录内的相对目录（'payloads/' 之类），用来当 basePath */
function relDirOfFile(fileRelPath: string, assetRelDir: string): string {
  let rel = String(fileRelPath || '').replace(/\\/g, '/');
  const dir = String(assetRelDir || '').replace(/\\/g, '/');
  if (dir && rel.toLowerCase().startsWith(dir.toLowerCase() + '/')) rel = rel.slice(dir.length + 1);
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

const dirOfUrl = (url: string) => {
  const i = url.lastIndexOf('/');
  return i >= 0 ? url.slice(0, i + 1) : '';
};

/** 与 USDComposer._resolveFilePath 同规则（去掉开头的 ./ 后拼 basePath） */
function resolveRefPath(ref: string, basePath: string): string {
  let p = String(ref || '').trim();
  if (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\\/g, '/');
  return basePath ? basePath + p : p;
}

function isCrate(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const magic = 'PXR-USDC';
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}
const isZip = (b: Uint8Array) => b.length > 1 && b[0] === 0x50 && b[1] === 0x4b;

const decoder = new TextDecoder();

function parseLayer(bytes: Uint8Array): any {
  if (isCrate(bytes)) return new USDCParser().parseData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return new USDAParser().parseData(decoder.decode(bytes));
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** 一层里出现的所有引用（references / payload），已去掉 @ 与 <prim> 包装 */
function collectRefs(parsed: any): string[] {
  const out: string[] = [];
  const specs = parsed?.specsByPath || {};
  for (const key in specs) {
    const f = specs[key]?.fields || {};
    for (const bucket of [f.references, f.payload]) {
      if (!bucket) continue;
      const list = Array.isArray(bucket) ? bucket : [bucket];
      for (const v of list) {
        if (typeof v === 'string') {
          const m = v.match(/@([^@]+)@/);
          if (m) out.push(m[1]);
        } else if (v && typeof v === 'object') {
          const ap = (v as any).assetPath || (v as any).path;
          if (ap) out.push(String(ap));
        }
      }
    }
  }
  return out;
}

/** 组合后巡检：材质、通道、贴图是否真的落地了 */
function inspect(root: THREE.Object3D, stats: UsdStats) {
  const matByUuid = new Map<string, UsdStats['materials'][number]>();
  const texSeen = new Set<string>();
  const pushMaps = (entry: UsdStats['materials'][number], m: any) => {
    const slots: [string, any][] = [
      ['baseColor', m?.map], ['normal', m?.normalMap], ['roughness', m?.roughnessMap],
      ['metallic', m?.metalnessMap], ['ao', m?.aoMap], ['emissive', m?.emissiveMap],
      ['alpha', m?.alphaMap], ['specular', (m as any)?.specularColorMap], ['displacement', (m as any)?.displacementMap]
    ];
    let idx = 0;
    for (const [slot, t] of slots) {
      if (!t) continue;
      const src = String(t.image?.src || t.userData?.src || '').split('/').pop() || `${slot}#${idx}`;
      idx++;
      if (!entry.maps.includes(slot)) entry.maps.push(slot);
      if (!t.image) {
        if (!entry.missing.includes(slot)) entry.missing.push(slot);
        stats.missingTextures.push(src);
      } else if (!texSeen.has(src)) {
        texSeen.add(src);
        stats.textures.push(src);
      }
    }
  };
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    stats.meshes++;
    const g = o.geometry;
    const idxCount = g?.index ? g.index.count : (g?.attributes?.position?.count || 0);
    stats.triangles += Math.floor(idxCount / 3);
    const mats: any[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const uid = m.uuid || m.name;
      let entry = matByUuid.get(uid);
      if (!entry) {
        entry = { name: String(m.name || o.name || '未命名材质'), maps: [], missing: [] };
        matByUuid.set(uid, entry);
        stats.materials.push(entry);
      }
      pushMaps(entry, m);
    }
  });
  stats.missingTextures = [...new Set(stats.missingTextures)];
  stats.textures = [...new Set(stats.textures)];
}

export interface UsdLoadResult {
  object: THREE.Group;
  stats: UsdStats;
}

/**
 * 读一个 USD 素材。抛错时消息尽量说清是「哪一层/哪张贴图」出问题。
 */
export async function loadUsdModel(args: UsdLoadArgs): Promise<UsdLoadResult> {
  const { assetId, fileId, relPath, assetRelDir, onStatus } = args;
  const maxLayers = args.maxLayers ?? 40;
  const fileDir = relDirOfFile(relPath, assetRelDir);
  const basePath = `/api/assetsrc/${assetId}/` + (fileDir ? enc(fileDir) + '/' : '');

  onStatus?.('读取 USD 根层…');
  const rootBytes = await fetchBytes(`/api/file/${fileId}`);

  const assets: Record<string, any> = {};
  const layers: string[] = [];
  const unresolved: string[] = [];
  let parsedRoot: any;

  if (isZip(rootBytes)) {
    // USDZ：整包解开，层与贴图都在包里（贴图给字节，composer 自建 blob URL）
    onStatus?.('解包 USDZ…');
    const zip = unzipSync(rootBytes);
    const names = Object.keys(zip);
    if (!names.length) throw new Error('USDZ 包是空的');
    for (const name of names) {
      if (LAYER_EXT_RE.test(name)) {
        assets[name] = parseLayer(zip[name]);
        layers.push(name);
      } else if (IMG_EXT_RE.test(name)) {
        assets[name] = zip[name];
      }
    }
    // 按规范第一项就是根层；万一写入器顺序不对，退回「第一个 USD 层」
    const rootName = names.find(n => LAYER_EXT_RE.test(n)) || names[0];
    parsedRoot = assets[rootName];
    if (!parsedRoot) throw new Error(`USDZ 里没有可用的 USD 层：${names.slice(0, 3).join(', ')}`);
    const zipBase = dirOfUrl(rootName);
    const composer = new USDComposer(null);
    const group: THREE.Group = composer.compose(parsedRoot, assets, {}, zipBase);
    await Promise.all(composer.texturePromises || []);
    const stats: UsdStats = { meshes: 0, triangles: 0, materials: [], textures: [], missingTextures: [], layers, unresolved };
    inspect(group, stats);
    group.userData.amUsd = stats;
    return { object: group, stats };
  }

  parsedRoot = parseLayer(rootBytes);
  layers.push(relPath);

  // 递归抓 references / payload 指向的层（同一份只抓一次）
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const enqueueChildren = (parsed: any, fromUrl: string, depth: number) => {
    for (const ref of collectRefs(parsed)) {
      if (/^[a-z]+:\/\//i.test(ref) || !LAYER_EXT_RE.test(ref)) { unresolved.push(ref); continue; }
      const url = resolveRefPath(ref, dirOfUrl(fromUrl));
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push({ url, depth });
    }
  };
  enqueueChildren(parsedRoot, `${basePath}${encodeURIComponent(String(relPath).split('/').pop() || 'root.usd')}`, 1);

  while (queue.length && layers.length < maxLayers) {
    const batch = queue.splice(0, queue.length);
    await Promise.all(batch.map(async ({ url, depth }) => {
      if (depth > 6) return;
      let bytes: Uint8Array;
      try {
        onStatus?.(`读取子层 ${decodeURIComponent(url).split('/').pop()}…`);
        bytes = await fetchBytes(url);
      } catch {
        unresolved.push(url);
        return;
      }
      const parsed = parseLayer(bytes);
      assets[url] = parsed;
      layers.push(decodeURIComponent(url).replace(/^\/api\/assetsrc\/\d+\//, ''));
      if (depth < 6) enqueueChildren(parsed, url, depth + 1);
    }));
  }

  onStatus?.('组合 USD 场景…');
  const composer = new USDComposer(null);
  const group: THREE.Group = composer.compose(parsedRoot, assets, {}, basePath);
  await Promise.all(composer.texturePromises || []);

  const stats: UsdStats = { meshes: 0, triangles: 0, materials: [], textures: [], missingTextures: [], layers, unresolved };
  inspect(group, stats);
  group.userData.amUsd = stats;
  return { object: group, stats };
}
