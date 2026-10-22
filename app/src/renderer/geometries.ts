import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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

/** 对自定义基本体按类型重算 UV（三向世界尺度投影，避免侧面/极点/端盖拉伸） */
export function remapUV(kind: PreviewGeometry, g: THREE.BufferGeometry) {
  if (!g.attributes.position) return;
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

export function makeGeometry(kind: PreviewGeometry, planeAxis: 'v' | 'h' = 'v'): THREE.BufferGeometry {
  if (kind === 'box') {
    const size = 1.7;
    // 圆角盒：先倒角，再细分所有面，保证高度置换在平面区域也有均匀顶点
    let g: THREE.BufferGeometry = new RoundedBoxGeometry(size, size, size, 24, 0.16);
    g = new TessellateModifier(0.045, 4).modify(g) as THREE.BufferGeometry;
    // 细分会拆散顶点，必须焊接后重算法线，否则倒角处出现黑缝
    g = mergeVertices(g, 1e-4);
    g.computeVertexNormals();
    planarUV(g);
    return withUv1(g);
  }
  if (kind === 'cylinder') {
    return withUv1(roundedCylinder(0.86, 2.0, 0.16, 160));
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
  // 球：用「立方体球化」+ 世界尺度投影代替经纬球，消除极点挤压
  const g = new THREE.BoxGeometry(2, 2, 2, 128, 128, 128);
  const pos = g.attributes.position;
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  planarUV(g);
  return withUv1(g);
}

