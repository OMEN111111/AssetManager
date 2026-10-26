import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** 一个纹理重复对应的世界尺寸；所有几何体共用，保证贴图密度一致 */
export const UV_WORLD = 2.0;

function withUv1(g: THREE.BufferGeometry) {
  if (!g.attributes.uv1 && g.attributes.uv) g.setAttribute('uv1', g.attributes.uv);
  return g;
}

/** 盒体：按顶点坐标主轴做世界尺度平面投影，避免棱边拉伸 */
function planarUV(g: THREE.BufferGeometry) {
  const pos = g.attributes.position;
  if (!pos) return;
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const ax = Math.abs(p.x), ay = Math.abs(p.y), az = Math.abs(p.z);
    let u = 0, v = 0;
    // 每个主轴面按 0.5 为中心展开，极点落在贴图中心，避免汇聚成一点
    const s = 1 / UV_WORLD;
    if (ax >= ay && ax >= az) { u = p.z * s + 0.5; v = p.y * s + 0.5; }
    else if (ay >= ax && ay >= az) { u = p.x * s + 0.5; v = p.z * s + 0.5; }
    else { u = p.x * s + 0.5; v = p.y * s + 0.5; }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** 盒体：按「三角面」选主轴做平面投影——同一三角形只用一套投影，避免跨轴三角形被拉伸，
 *  只在倒角过渡处留下细缝（这是盒式投影的固有特性）。会把几何转成非索引以便逐角写 UV。 */
function planarUVByTriangle(g: THREE.BufferGeometry) {
  const src: THREE.BufferGeometry = g.index ? g.toNonIndexed() : g;
  const pos = src.attributes.position;
  if (!pos) return g;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const s = 1 / UV_WORLD;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u = 0, v = 0;
      if (ax >= ay && ax >= az) { u = p.z * s + 0.5; v = p.y * s + 0.5; }
      else if (ay >= ax && ay >= az) { u = p.x * s + 0.5; v = p.z * s + 0.5; }
      else { u = p.x * s + 0.5; v = p.y * s + 0.5; }
      uv[(i + k) * 2] = u; uv[(i + k) * 2 + 1] = v;
    }
  }
  g.setIndex(null);
  g.setAttribute('position', pos.clone());
  if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
  return g;
}

/** 球：按弧长换算 UV，u/v 使用同一个世界尺度 */
function sphereUV(g: THREE.BufferGeometry, radius: number) {
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const az = Math.atan2(p.x, p.z);
    const polar = Math.acos(THREE.MathUtils.clamp(p.y / radius, -1, 1));
    uv[i * 2] = (az * radius) / UV_WORLD;
    uv[i * 2 + 1] = (polar * radius) / UV_WORLD;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function resampleEven(points: THREE.Vector2[], count: number) {
  const seg: number[] = [0];
  for (let i = 1; i < points.length; i++) seg.push(seg[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = seg[seg.length - 1] || 1;
  const out: THREE.Vector2[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (j < seg.length - 2 && seg[j + 1] < target) j++;
    const t = (target - seg[j]) / Math.max(seg[j + 1] - seg[j], 1e-6);
    out.push(new THREE.Vector2().lerpVectors(points[j], points[j + 1], Math.min(1, Math.max(0, t))));
  }
  return { points: out, total };
}

/** 圆角圆柱：侧面按弧长、顶底盖按世界尺度平面投影，三处密度一致 */
function roundedCylinder(radius: number, height: number, fillet: number, radial: number) {
  const h = height / 2;
  const r = radius;
  const f = Math.min(fillet, r * 0.45, h * 0.45);
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -h)];

  const arcSeg = 16;
  const cx = r - f, cy = -h + f;
  for (let i = 0; i <= arcSeg; i++) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / arcSeg);
    pts.push(new THREE.Vector2(cx + f * Math.cos(a), cy + f * Math.sin(a)));
  }
  const side = 8;
  for (let i = 1; i <= side; i++) {
    pts.push(new THREE.Vector2(r, -h + f + 2 * (h - f) * (i / side)));
  }
  const cx2 = r - f, cy2 = h - f;
  for (let i = 0; i <= arcSeg; i++) {
    const a = (Math.PI / 2) * (i / arcSeg);
    pts.push(new THREE.Vector2(cx2 + f * Math.cos(a), cy2 + f * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(0, h));

  const { points, total } = resampleEven(pts, 180);
  const g = new THREE.LatheGeometry(points, radial);

  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const vNorm = uv.getY(i);
    const ang = Math.atan2(x, z);
    if (Math.abs(Math.abs(y) - h) < 1e-3) {
      // 平盖：世界尺度平面 UV，与侧面同密度
      uv.setXY(i, x / UV_WORLD, z / UV_WORLD);
    } else {
      // 侧面：U 用弧长、V 直接用高度，保证与盖面同密度且无纵向拉伸
      uv.setXY(i, (ang * r) / UV_WORLD, (y + h) / UV_WORLD);
    }
  }
  uv.needsUpdate = true;

  g.computeVertexNormals();
  return g;
}

export type PreviewGeometry = 'sphere' | 'box' | 'cylinder' | 'plane';

/** 对「没有 UV」的自定义基本体按类型生成 UV（只做兜底；有自带 UV 的模型不要覆盖） */
export function remapUV(kind: PreviewGeometry, g: THREE.BufferGeometry) {
  const pos = g.attributes.position;
  if (!pos) return;
  if (kind === 'sphere') {
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
    sphereUV(g, radius);
    return;
  }
  if (kind === 'cylinder') {
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox.getSize(size);
    const half = size.y / 2 || 1;
    const uv = new Float32Array(pos.count * 2);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      const rad = Math.hypot(p.x, p.z);
      const ang = Math.atan2(p.x, p.z);
      if (Math.abs(Math.abs(p.y) - half) < 1e-3) {
        uv[i * 2] = p.x / UV_WORLD; uv[i * 2 + 1] = p.z / UV_WORLD;
      } else {
        // 用局部半径算弧长，倒角处不会被拉伸
        uv[i * 2] = (ang * rad) / UV_WORLD;
        uv[i * 2 + 1] = (p.y + half) / UV_WORLD;
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return;
  }
  if (kind === 'box') { planarUVByTriangle(g); return; }
  if (kind !== 'plane') planarUV(g);
}

/** 90° 旋转几何时同步旋转 UV，保持棋盘格不被拉长 */
export function rotateUV90(g: THREE.BufferGeometry) {
  const uv = g.attributes.uv;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, v, u);
  }
  uv.needsUpdate = true;
}

/** 把圆柱轴摆正到 Y（用顶点分布方差判断轴向，适用于长宽接近的包围体） */
export function uprightCylinder(g: THREE.BufferGeometry) {
  const p = g.attributes.position;
  let xx = 0, yy = 0, zz = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    xx += x * x; yy += y * y; zz += z * z;
  }
  if (zz >= xx && zz >= yy) g.rotateX(-Math.PI / 2);
  else if (xx >= yy && xx >= zz) g.rotateZ(Math.PI / 2);
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
}


/**
 * 按「空间位置」平滑法线：只按位置合并法线，不受 UV 接缝影响。
 * 圆角方细分后同一位置的顶点会因 UV 断开而重复，computeVertexNormals 会各算各的，
 * 倒角处就出现一条暗缝 —— 这里按位置累加面法线（面积加权）再统一归一化。
 */
export function smoothNormalsByPosition(g: THREE.BufferGeometry) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index;
  const keyOf = (i: number) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const acc = new Map<string, THREE.Vector3>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), cb = new THREE.Vector3(), fn = new THREE.Vector3();
  const tri = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    cb.subVectors(c, b);
    ab.subVectors(a, b);
    fn.crossVectors(cb, ab);            // 未归一化 = 面积加权
    for (const i of [i0, i1, i2]) {
      const k = keyOf(i);
      let v = acc.get(k);
      if (!v) { v = new THREE.Vector3(); acc.set(k, v); }
      v.add(fn);
    }
  }
  const normals = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = acc.get(keyOf(i));
    if (v && v.lengthSq() > 1e-12) {
      const n = v.clone().normalize();
      normals[i * 3] = n.x; normals[i * 3 + 1] = n.y; normals[i * 3 + 2] = n.z;
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}

export function makeGeometry(kind: PreviewGeometry, planeAxis: 'v' | 'h' = 'v'): THREE.BufferGeometry {
  if (kind === 'box') {
    const size = 1.7;
    // 圆角盒：直接用高分段圆角盒。
    // 不要再用 TessellateModifier 细分——它是逐三角形细分，会在共享边留下 T 型接点：
    // 平面时看不出来，一开置换两个三角形的顶点位移不同就裂成黑缝。
    const g: THREE.BufferGeometry = new RoundedBoxGeometry(size, size, size, 160, 0.16);
    planarUVByTriangle(g);
    smoothNormalsByPosition(g);   // 倒角处不再出现暗缝
    return withUv1(g);
  }
  if (kind === 'cylinder') {
    const g = roundedCylinder(0.86, 2.0, 0.16, 160);
    smoothNormalsByPosition(g);   // 侧壁与顶/底盖交界同理
    return withUv1(g);
  }
  if (kind === 'plane') {
    const g = new THREE.PlaneGeometry(2.4, 2.4, 96, 96);
    if (planeAxis === 'h') g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i,
        pos.getX(i) / UV_WORLD + 0.5,
        (planeAxis === 'h' ? pos.getZ(i) : pos.getY(i)) / UV_WORLD + 0.5);
    }
    uv.needsUpdate = true;
    g.computeVertexNormals();
    return withUv1(g);
  }
  // 球：经纬球自带正确 UV（接缝处顶点重复，不会插值出缝），UV 按世界尺度铺开
  const g = new THREE.SphereGeometry(1, 192, 96);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (2 * Math.PI / UV_WORLD), uv.getY(i) * (Math.PI / UV_WORLD));
  }
  uv.needsUpdate = true;
  g.computeVertexNormals();
  return withUv1(g);
}

