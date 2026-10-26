import * as THREE from '../../app/node_modules/three/build/three.module.js';

// ---- CPU 公式（Assembler.tsx displaceByHeight 里的那几行） ----
function cpuUv(u0, v0, cfg) {
  const sx = cfg.repeatU ?? 1, sy = cfg.repeatV ?? 1;
  const rot = cfg.rot ?? 0, tx = cfg.offsetU ?? 0, ty = cfg.offsetV ?? 0;
  const ccx = 0.5, ccy = 0.5;
  const co = Math.cos(rot), si = Math.sin(rot);
  const consU = -sx * (co * ccx + si * ccy) + ccx + tx;
  const consV = -sy * (-si * ccx + co * ccy) + ccy + ty;
  return [
    sx * (co * u0 + si * v0) + consU,
    sy * (-si * u0 + co * v0) + consV
  ];
}

// ---- GPU 公式（three 的 texture.matrix，实际渲染时用的那个） ----
function gpuUv(u0, v0, cfg) {
  const t = new THREE.Texture();
  t.center.set(0.5, 0.5);
  t.repeat.set(cfg.repeatU ?? 1, cfg.repeatV ?? 1);
  t.offset.set(cfg.offsetU ?? 0, cfg.offsetV ?? 0);
  t.rotation = cfg.rot ?? 0;
  t.updateMatrix();
  const e = t.matrix.elements; // 列主序
  return [e[0] * u0 + e[3] * v0 + e[6], e[1] * u0 + e[4] * v0 + e[7]];
}

const cases = [
  { name: '默认', repeatU: 1, repeatV: 1, rot: 0, offsetU: 0, offsetV: 0 },
  { name: '平铺 2/2', repeatU: 2, repeatV: 2, rot: 0, offsetU: 0, offsetV: 0 },
  { name: '平铺 2/3', repeatU: 2, repeatV: 3, rot: 0, offsetU: 0, offsetV: 0 },
  { name: '旋转 30°', repeatU: 1, repeatV: 1, rot: Math.PI / 6, offsetU: 0, offsetV: 0 },
  { name: '旋转 30°+平铺2', repeatU: 2, repeatV: 2, rot: Math.PI / 6, offsetU: 0, offsetV: 0 },
  { name: '位移 .3/.7', repeatU: 1, repeatV: 1, rot: 0, offsetU: 0.3, offsetV: 0.7 },
  { name: '全开', repeatU: 2.5, repeatV: 1.5, rot: 0.7, offsetU: -0.2, offsetV: 0.4 },
];

let worst = 0;
for (const c of cases) {
  let maxd = 0;
  for (const [u0, v0] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.25, 0.8]]) {
    const a = cpuUv(u0, v0, c), b = gpuUv(u0, v0, c);
    maxd = Math.max(maxd, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }
  worst = Math.max(worst, maxd);
  console.log(`${c.name.padEnd(12)} CPU-vs-three矩阵 最大偏差 = ${maxd.toExponential(2)}`);
}
console.log('three revision:', THREE.REVISION, ' 总体最大偏差:', worst.toExponential(2));
