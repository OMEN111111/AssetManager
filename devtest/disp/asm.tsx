// 真机验证：把**真实的 Assembler 组件**挂起来，用一个「高度图不是方形」的真实素材跑一遍，
// 因为置换几何是 CPU 算的，所以可以直接从 __asmApi.mesh 读出每个顶点的位移量，
// 再和「按贴图实际 UV 变换取样」（修复后）／「只按 cfg.uv 取样」（修复前）两个高度场做相关性比较。
import React from 'react';
import { createRoot } from 'react-dom/client';
import Assembler from '../../app/src/renderer/Assembler';
import { sampleTexel } from '../../app/src/renderer/matlib';
import { makeGeometry } from '../../app/src/renderer/geometries';
import * as THREE from 'three';
import '../../app/src/renderer/styles.css';

const DIR = 'F:/02AssetLibrary/Asset/02_Materials/Bricks/Bricks_4k_001/';
const files = [
  { id: 21, rel_path: DIR + 'Bricks_4k_Basecolor.jpg', role: 'texture', slot: null, size: 0 },
  { id: 22, rel_path: DIR + 'Bricks_4k_Height.jpg', role: 'texture', slot: null, size: 0 },
  { id: 23, rel_path: DIR + 'Bricks_4k_Normal.jpg', role: 'texture', slot: null, size: 0 },
  { id: 24, rel_path: DIR + 'Bricks_4k_Roughness.jpg', role: 'texture', slot: null, size: 0 },
  { id: 25, rel_path: DIR + 'Bricks_4k_AO.jpg', role: 'texture', slot: null, size: 0 }
];
const asset: any = {
  id: 0, library_id: 1, rel_dir: '02_Materials/Bricks/Bricks_4k_001', name: 'Bricks_4k_001',
  type: 'material', ext: '.mtlx', category: null, size: 0, rating: 0, favorite: 0,
  preview_rel: null, material_json: null, root: 'F:/02AssetLibrary/Asset',
  files, slotMap: null
};

const root = createRoot(document.getElementById('root')!);
root.render(<Assembler asset={asset} onClose={() => { /* 测试页 */ }} />);

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const corr = (P: number[], Q: number[]) => {
  const n = P.length; let mp = 0, mq = 0;
  for (let i = 0; i < n; i++) { mp += P[i]; mq += Q[i]; }
  mp /= n; mq /= n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { const dp = P[i] - mp, dq = Q[i] - mq; a += dp * dq; b += dp * dp; c += dq * dq; }
  return +(a / Math.sqrt(b * c || 1e-9)).toFixed(4);
};
const meanAbs = (P: number[], Q: number[]) => {
  let s = 0; for (let i = 0; i < P.length; i++) s += Math.abs(P[i] - Q[i]);
  return +(s / P.length).toFixed(4);
};

/** 从真实组件里验证「置换与贴图对齐」 */
(window as any).__verify = async () => {
  const api: any = (window as any).__asmApi;
  if (!api?.mesh) return { error: 'mesh 还没建好' };
  const dm: any = api.baseMat?.userData?.dispMap || api.baseMat?.displacementMap;
  if (!dm) return { error: '置换贴图还没准备好' };
  dm.updateMatrix();
  const img: any = dm.image;
  const w = img.width, h = img.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;
  const flipY = dm.flipY !== false;
  const e = dm.matrix.elements;

  const g = api.mesh.geometry;
  const pos = g.attributes.position, uv = g.attributes.uv;
  const SCALE = 0.03;                          // matlib.DISP_SCALE，强度默认 1
  const actual: number[] = [], fixed: number[] = [], before: number[] = [];
  for (let i = 0; i < pos.count; i += 7) {     // 抽样，约 2600 个点
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const d = Math.sqrt(px * px + py * py + pz * pz) - 1;   // 球半径 1 → |p|-1 = 位移量
    actual.push(d / (2 * SCALE) + 0.5);                     // 还原成高度值
    const u0 = uv.getX(i), v0 = uv.getY(i);
    const au = e[0] * u0 + e[3] * v0 + e[6], av = e[1] * u0 + e[4] * v0 + e[7];
    fixed.push(sampleTexel(data, w, h, au, av, 'r', flipY));       // 贴图实际取样（= 修复后 CPU 走的路径）
    before.push(sampleTexel(data, w, h, u0, v0, 'r', flipY));      // 修复前：只认 cfg.uv（= 1/1）
  }
  return {
    texture: `${w}x${h}`,
    tex_repeat: [dm.repeat.x, dm.repeat.y],
    vertices: pos.count,
    sampled: actual.length,
    '置换 vs 贴图实际取样（修复后）': { corr: corr(actual, fixed), meanAbs: meanAbs(actual, fixed) },
    '置换 vs 只按 cfg.uv（修复前）': { corr: corr(actual, before), meanAbs: meanAbs(actual, before) }
  };
};

/** 通用检查：拿当前基本体的「未置换」版本逐点比位移量，再和两种高度场口径对照 */
(window as any).__verifyAny = async (kind: string, axis: 'v' | 'h' = 'v') => {
  const api: any = (window as any).__asmApi;
  if (!api?.mesh) return { error: 'mesh 还没建好' };
  const dm: any = api.baseMat?.userData?.dispMap || api.baseMat?.displacementMap;
  if (!dm) return { error: '置换贴图还没准备好' };
  dm.updateMatrix();
  const img: any = dm.image;
  const w = img.width, h = img.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;
  const flipY = dm.flipY !== false;
  const e = dm.matrix.elements;

  const base = makeGeometry(kind as any, axis);
  const g = api.mesh.geometry;
  const pc = base.attributes.position.count, gc = g.attributes.position.count;
  if (pc !== gc) return { error: `顶点数不一致 base=${pc} mesh=${gc}` };
  const bp = base.attributes.position, bn = base.attributes.normal;
  const gp = g.attributes.position, guv = g.attributes.uv;
  const SCALE = 0.03;
  const actual: number[] = [], fixed: number[] = [], before: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), a0 = new THREE.Vector3(), n0 = new THREE.Vector3();
  let dMax = 0, dMin = 0;
  const step = Math.max(1, Math.floor(pc / 3000));
  for (let i = 0; i < pc; i += step) {
    a.fromBufferAttribute(gp, i); a0.fromBufferAttribute(bp, i); n0.fromBufferAttribute(bn, i);
    b.subVectors(a, a0);
    const d = b.dot(n0);                       // 沿原法线的位移量
    if (d > dMax) dMax = d; if (d < dMin) dMin = d;
    actual.push(d / (2 * SCALE) + 0.5);
    const u0 = guv.getX(i), v0 = guv.getY(i);
    const au = e[0] * u0 + e[3] * v0 + e[6], av = e[1] * u0 + e[4] * v0 + e[7];
    fixed.push(sampleTexel(data, w, h, au, av, 'r', flipY));
    before.push(sampleTexel(data, w, h, u0, v0, 'r', flipY));
  }
  return {
    geometry: kind, axis, vertices: pc, sampled: actual.length,
    displacement_range: [+dMin.toFixed(5), +dMax.toFixed(5)],
    texture: `${w}x${h}`, tex_repeat: [dm.repeat.x, dm.repeat.y],
    '置换 vs 贴图实际取样（修复后）': { corr: corr(actual, fixed), meanAbs: meanAbs(actual, fixed) },
    '置换 vs 只按 cfg.uv（修复前）': { corr: corr(actual, before), meanAbs: meanAbs(actual, before) }
  };
};

(async () => {
  await wait(4000);
  try {
    const r = await (window as any).__verify();
    (window as any).__verifyResult = r;
    document.title = 'DONE';
  } catch (err: any) {
    (window as any).__verifyResult = { error: String(err?.stack || err) };
    document.title = 'FAILED';
  }
})();
