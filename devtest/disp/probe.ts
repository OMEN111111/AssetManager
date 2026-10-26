// 置换「对齐」验证探针：用真实的 matlib.buildMaterial 取到置换器实际用的那张贴图，
// 再用 4 种取样方式算同一块平面上的高度场，与 GPU 渲染结果逐一比对。
//  - G：GPU 真值（three 用 MeshBasicMaterial(map) 采样，就是通道预览里看到的那张图）
//  - A：按 texture.matrix 复算（应当 ≈ G）
//  - B：修复前 Assembler.tsx 里的 CPU 公式（只认 cfg.uv，漏了宽高比修正）
//  - C：修复后 —— matlib.effectiveUv/applyUvXform/sampleTexel（装配器现在直接调这三个）
import * as THREE from 'three';
import { buildMaterial, effectiveUv, applyUvXform, sampleTexel } from '../../app/src/renderer/matlib';
import { makeGeometry } from '../../app/src/renderer/geometries';

const N = 256;
const results: any[] = [];
// matlib.loadTexture 的缓存键是「文件 id」，各用例必须用不同 id，否则会拿到同一张贴图
let _id = 0;
const nextId = () => ++_id;

/** 修复前 Assembler.tsx 里的 CPU UV 公式（只认 cfg.uv，漏掉宽高比修正）—— 仅用于对照 */
function oldCpuUv(u0: number, v0: number, cfg: any) {
  const sx = cfg.repeatU ?? 1, sy = cfg.repeatV ?? 1;
  const rot = cfg.rot ?? 0, tx = cfg.offsetU ?? 0, ty = cfg.offsetV ?? 0;
  const ccx = 0.5, ccy = 0.5;
  const co = Math.cos(rot), si = Math.sin(rot);
  const consU = -sx * (co * ccx + si * ccy) + ccx + tx;
  const consV = -sy * (-si * ccx + co * ccy) + ccy + ty;
  return [sx * (co * u0 + si * v0) + consU, sy * (-si * u0 + co * v0) + consV];
}

/** 修复前 Assembler.tsx 的取像素方式（只取 R 通道）—— 仅用于对照 */
function makeOldSampler(img: any) {
  const w = img.width, h = img.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0, w, h);
  const data = cx.getImageData(0, 0, w, h).data;
  return {
    w, h, data,
    sample(u: number, v: number) {
      const x = Math.min(w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * w)));
      const y = Math.min(h - 1, Math.max(0, Math.floor((v - Math.floor(v)) * h)));
      return data[(y * w + x) * 4] / 255;
    }
  };
}

const stat = (P: Float32Array, Q: Float32Array) => {
  let sum = 0, max = 0;
  for (let i = 0; i < P.length; i++) { const d = Math.abs(P[i] - Q[i]); sum += d; if (d > max) max = d; }
  return { meanAbs: +(sum / P.length).toFixed(4), maxAbs: +max.toFixed(4) };
};
const corr = (P: Float32Array, Q: Float32Array) => {
  let mp = 0, mq = 0;
  for (let i = 0; i < P.length; i++) { mp += P[i]; mq += Q[i]; }
  mp /= P.length; mq /= P.length;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < P.length; i++) { const dp = P[i] - mp, dq = Q[i] - mq; a += dp * dq; b += dp * dp; c += dq * dq; }
  return +(a / Math.sqrt(b * c || 1e-9)).toFixed(4);
};

async function runCase(label: string, relPath: string, uv?: any) {
  const files: any = [{ id: nextId(), asset_id: 1, rel_path: relPath, role: 'texture', slot: null, size: 0, mtime: 0 }];
  // 装配器打开没存过配置的素材时走 detectConfig，这里只给 height 通道，uv 缺省（= 1/1）
  const cfg: any = { workflow: 'MR', channels: { height: { fileId: files[0].id, channel: 'r', intensity: 1, strength: 1 } } };
  if (uv) cfg.uv = uv;
  const mat: any = await buildMaterial(files, cfg);
  const dm: any = mat.displacementMap;
  dm.updateMatrix();
  const img: any = dm.image;
  const old = makeOldSampler(img);
  const flipY = dm.flipY !== false;
  const e = dm.matrix.elements;
  const a = (img.width || 0) / (img.height || 0);

  const uvCfg = uv ?? { repeatU: 1, repeatV: 1, rot: 0, offsetU: 0, offsetV: 0 };  // = Assembler 的 cfg.uv 缺省值
  const xf = effectiveUv(uvCfg, img.width, img.height);   // 修复后装配器用的就是这一份
  const G = new Float32Array(N * N);
  const A = new Float32Array(N * N);
  const B = new Float32Array(N * N);
  const C = new Float32Array(N * N);

  for (let py = 0; py < N; py++) {           // py=0 是平面底边（与 GL readPixels 行序一致）
    for (let px = 0; px < N; px++) {
      const x = ((px + 0.5) / N) * 2.4 - 1.2;
      const y = ((py + 0.5) / N) * 2.4 - 1.2;
      const u0 = x / 2 + 0.5, v0 = y / 2 + 0.5;      // makeGeometry('plane') 的 UV
      const i = py * N + px;
      const au = e[0] * u0 + e[3] * v0 + e[6];
      const av = e[1] * u0 + e[4] * v0 + e[7];
      A[i] = old.sample(au, flipY ? 1 - av : av);
      const [bu, bv] = oldCpuUv(u0, v0, uvCfg);
      B[i] = old.sample(bu, flipY ? 1 - bv : bv);
      const [cu, cv] = applyUvXform(u0, v0, xf);
      C[i] = sampleTexel(old.data, old.w, old.h, cu, cv, 'r', flipY);
    }
  }

  // GPU 真值
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(N, N, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const rt = new THREE.WebGLRenderTarget(N, N);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 10);
  cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0);
  const mesh = new THREE.Mesh(makeGeometry('plane'),
    new THREE.MeshBasicMaterial({ map: dm, color: 0xffffff, toneMapped: false }));
  scene.add(mesh);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const buf = new Uint8Array(N * N * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, N, N, buf);
  for (let row = 0; row < N; row++) {
    for (let px = 0; px < N; px++) G[row * N + px] = buf[(row * N + px) * 4] / 255;
  }
  renderer.dispose();

  const rec = {
    label,
    file: relPath.split(/[\\/]/).pop(),
    image: `${img.width}x${img.height}`,
    aspect: +a.toFixed(3),
    flipY,
    tex_repeat: [dm.repeat.x, dm.repeat.y],
    tex_offset: [dm.offset.x, dm.offset.y],
    tex_center: [dm.center.x, dm.center.y],
    cpu_repeat_used: [uvCfg.repeatU, uvCfg.repeatV],
    effective_uv: [xf.repeatU, xf.repeatV, +xf.rot.toFixed(3), xf.offsetU, xf.offsetV, !!xf.aspectFixed],
    'GPU vs texture.matrix(A)': { ...stat(G, A), corr: corr(G, A) },
    'GPU vs 修复前CPU公式(B)': { ...stat(G, B), corr: corr(G, B) },
    'GPU vs 修复后CPU取样(C)': { ...stat(G, C), corr: corr(G, C) },
    B_vs_C: { ...stat(B, C), corr: corr(B, C) }
  };
  results.push({ rec, fields: { G, A, B, C } });
  return rec;
}

function drawAll() {
  const pane = N, gap = 8;
  const cv = document.createElement('canvas');
  cv.width = results.length * 4 * pane + (results.length * 4 - 1) * gap;
  cv.height = pane + 26;
  cv.style.width = Math.min(1420, cv.width) + 'px';
  cv.style.height = 'auto';
  const cx = cv.getContext('2d')!;
  cx.fillStyle = '#101216'; cx.fillRect(0, 0, cv.width, cv.height);
  const out: any[] = [];
  let x0 = 0;
  results.forEach(({ rec, fields }) => {
    const titles = [
      ['GPU 真值（预览取样）', fields.G],
      ['按 texture.matrix 复算', fields.A],
      ['修复前 CPU 公式', fields.B],
      ['修复后 CPU 取样', fields.C]
    ] as [string, Float32Array][];
    for (const [t, F] of titles) {
      const tmp = document.createElement('canvas');
      tmp.width = pane; tmp.height = pane;
      const tc = tmp.getContext('2d')!;
      const id = tc.createImageData(pane, pane);
      for (let row = 0; row < pane; row++) {
        for (let px = 0; px < pane; px++) {
          const v = Math.round(F[row * pane + px] * 255);
          const o = ((pane - 1 - row) * pane + px) * 4;   // 转成上到下
          id.data[o] = id.data[o + 1] = id.data[o + 2] = v; id.data[o + 3] = 255;
        }
      }
      tc.putImageData(id, 0, 0);
      cx.drawImage(tmp, x0, 26);
      cx.fillStyle = '#cfd6e2'; cx.font = '12px Consolas';
      cx.fillText(`${rec.file} · ${t}`, x0 + 2, 16);
      out.push({ pane: t, x: x0 });
      x0 += pane + gap;
    }
  });
  document.body.appendChild(cv);
  return out;
}

async function main() {
  const pre = document.getElementById('metrics')!;
  const status = (s: string) => { pre.textContent = s; };
  status('running…');
  // 对照组：方形图；问题组：库中真实的非方形置换图
  await runCase('方形高度图（对照组）', 'F:/02AssetLibrary/Asset/02_Materials/Bamboo/Bamboo_4k_001/Bamboo_4k_Height.jpg');
  await runCase('非方形高度图 4096x2048', 'F:/02AssetLibrary/Asset/02_Materials/Bricks/Bricks_4k_001/Bricks_4k_Height.jpg');
  await runCase('非方形高度图 2048x4096', 'F:/02AssetLibrary/Asset/02_Materials/Wood/Wood_4k_003/Wood_4k_Height.jpg');
  // 第四组：同一张非方形图，但「整体 UV」被设成 2/2 —— 这时 texFor 走进 hasUv 分支、不再做宽高比修正
  await runCase('非方形 + 平铺2/2', 'F:/02AssetLibrary/Asset/02_Materials/Bricks/Bricks_4k_002/Bricks_4k_Height.jpg',
    { repeatU: 2, repeatV: 2, rot: 0, offsetU: 0, offsetV: 0 });
  const panes = drawAll();
  const report = { panes, results: results.map(r => r.rec), fields: results.map(r => r.fields) };
  pre.textContent = JSON.stringify(report.results, null, 1);
  (window as any).__probe = report;
  document.title = 'DONE';
}

main().catch(e => {
  document.getElementById('metrics')!.textContent = 'FAILED: ' + (e && e.stack || e);
  document.title = 'FAILED';
});

