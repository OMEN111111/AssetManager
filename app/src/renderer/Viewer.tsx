import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { assertBinaryFbx } from './fbxcheck';
import { SPECIAL_TEX, preloadSpecialTextures, specialTextureUrl } from './specialtex';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { IESLoader } from 'three/examples/jsm/loaders/IESLoader.js';
import NumField from './NumField';
import { detectConfig, loadTexture } from './matlib';
import { makeGeometry } from './geometries';
import type { AssetDetail, AssetFile } from './types';

type Preset = 'maya' | 'max' | 'blender';

/** 解析 IESNA 文本，取垂直配光曲线（平均水平角），用于推导光束角与光斑衰减 */
function kelvinToColor(k: number): THREE.Color {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function findFile(files: AssetFile[], ...keys: string[]) {
  for (const k of keys) {
    const hit = files.find(f => String(f.rel_path).toLowerCase().includes(k));
    if (hit) return hit;
  }
  return undefined;
}

interface IesFull { hor: number[]; ver: number[]; cd: number[][]; peak: number; maxPhi: number; maxTheta: number }

/** 解析 IESNA：保留完整 水平角 × 垂直角 candela 网格（不做任何平均） */
export function parseIesFull(text: string): IesFull | null {
  try {
    const clean = text.replace(/\r/g, '');
    const tiltIdx = clean.indexOf('TILT=');
    let body = clean;
    if (tiltIdx >= 0) {
      const nl = clean.indexOf('\n', tiltIdx);
      body = clean.slice(nl + 1);
      if (/TILT=INCLUDE/i.test(clean.slice(tiltIdx, nl))) {
        // TILT=INCLUDE: lamp count / tilt angle count / angles / factors —— 粗跳过 4 行
        body = body.split('\n').slice(4).join('\n');
      }
    }
    const nums = (body.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []).map(Number);
    if (nums.length < 12) return null;
    let i = 0;
    i += 1; // num lamps
    i += 1; // lumens per lamp
    const multi = nums[i++] || 1;
    const nVer = nums[i++];
    const nHor = nums[i++];
    i += 8; // photometric type / units / width / length / height + ballast / future / watts
    if (!nVer || !nHor || nums.length < i + nVer + nHor + nVer * nHor) return null;
    const ver = nums.slice(i, i + nVer); i += nVer;
    const hor = nums.slice(i, i + nHor); i += nHor;
    const flat = nums.slice(i, i + nVer * nHor);
    const cd: number[][] = [];
    let peak = 0;
    for (let v = 0; v < nVer; v++) {
      const row: number[] = [];
      for (let h = 0; h < nHor; h++) {
        const val = (flat[v * nHor + h] || 0) * multi;
        row.push(val);
        if (val > peak) peak = val;
      }
      cd.push(row);
    }
    const maxPhi = (ver[ver.length - 1] || 90) * Math.PI / 180;
    const maxTheta = Math.max(1e-4, (hor[hor.length - 1] || 90)) * Math.PI / 180;
    return { hor, ver, cd, peak: Math.max(1e-6, peak), maxPhi, maxTheta };
  } catch {
    return null;
  }
}

/** 完整 2D IES 贴图：宽度=水平角，高度=垂直角（浮点红通道） */
function iesDataTexture(ies: IesFull): THREE.DataTexture {
  const w = ies.hor.length;
  const h = ies.ver.length;
  const data = new Uint8Array(w * h);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) data[v * w + u] = Math.max(0, Math.min(255, Math.round((ies.cd[v][u] / ies.peak) * 255)));
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 把 IES 烘成 360°×N 的极坐标贴图：按文件水平角范围做对称展开，避免象限折叠出四叶草 */
export function ies360Texture(ies: IesFull): THREE.DataTexture {
  const W = 360;
  const H = ies.ver.length;
  const data = new Uint8Array(W * H);
  const h0 = ies.hor[0] ?? 0;
  const h1 = ies.hor[ies.hor.length - 1] ?? 0;
  const span = Math.abs(h1 - h0);
  const sample = (row: number[], deg: number) => {
    const hor = ies.hor;
    if (!hor.length) return row[0] || 0;
    if (deg <= hor[0]) return row[0] || 0;
    if (deg >= hor[hor.length - 1]) return row[hor.length - 1] || 0;
    for (let k = 0; k < hor.length - 1; k++) {
      if (deg >= hor[k] && deg <= hor[k + 1]) {
        const t = (deg - hor[k]) / Math.max(1e-6, hor[k + 1] - hor[k]);
        return row[k] * (1 - t) + row[k + 1] * t;
      }
    }
    return row[row.length - 1] || 0;
  };
  for (let d = 0; d < W; d++) {
    let t: number;
    if (span >= 359) {
      // 0..360 完整分布
      t = (d - h0 + 720) % 360;
    } else if (h0 <= 0.001 && h1 >= 179 && h1 <= 181) {
      // 0..180：两侧对称
      t = d <= 180 ? d : 360 - d;
    } else if (h0 <= 0.001 && h1 <= 91) {
      // 0..90：四象限对称
      const m = d % 180;
      t = m <= 90 ? m : 180 - m;
    } else {
      // -X..X 或其它：按绝对值镜像
      const signed = d <= 180 ? d : d - 360;
      t = Math.abs(signed);
      if (t > h1) t = h1;
      if (t < h0) t = h0;
    }
    for (let v = 0; v < H; v++) {
      const val = sample(ies.cd[v], t);
      data[v * W + d] = Math.max(0, Math.min(255, Math.round((val / ies.peak) * 255)));
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 把 IES 逐像素采样注入标准材质（真实配光，不是投影贴图） */
export function iesMaterial(params: any, uni: any): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial(params);
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vIesWPos; varying vec3 vIesN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvIesN = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvIesWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vIesWPos; varying vec3 vIesN;
        uniform sampler2D uIesTex; uniform vec3 uLightPos; uniform vec3 uIesColor;
        uniform float uIesIntensity; uniform float uMaxPhi; uniform float uMaxTheta;
        uniform float uInnerRad; uniform float uOuterRad; uniform float uIesPeak;
        uniform vec3 uAxis; uniform float uBoth; uniform float uAzOffset;`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 toL = uLightPos - vIesWPos;
          float d2 = max(0.0001, dot(toL, toL));
          vec3 L = normalize(toL);
          for (int k = 0; k < 2; k++) {
            if (k == 1 && uBoth < 0.5) break;
            vec3 axis = normalize(uAxis) * (k == 0 ? 1.0 : -1.0);
            float phi = acos(clamp(dot(-L, axis), -1.0, 1.0));
            float cut = 1.0 - smoothstep(uInnerRad, uOuterRad, phi);
            if (phi <= uMaxPhi && cut > 0.0) {
              vec3 refv = abs(axis.y) > 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
              vec3 right = normalize(cross(refv, axis));
              vec3 fwd = normalize(cross(axis, right));
              float th = atan(dot(L, fwd), dot(L, right));
              float u = fract((th + 3.14159265) / 6.2831853 + uAzOffset + (k == 1 ? 0.5 : 0.0));
              float v = clamp(phi / uMaxPhi, 0.0, 1.0);
              float cd = texture2D(uIesTex, vec2(u, v)).r;
              float ndl = max(0.0, dot(normalize(vIesN), L));
              outgoingLight += diffuseColor.rgb * uIesColor * uIesIntensity * cd * ndl * cut / d2;
            }
          }
        }
        #include <opaque_fragment>`);
  };
  mat.userData.iesUni = uni;
  mat.customProgramCacheKey = () => 'ies-v1';
  return mat;
}

export default function Viewer({ asset, onClose, variants, onVariant }:
  { asset: AssetDetail; onClose: () => void; variants?: any[]; onVariant?: (id: number) => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const uvCanvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<any>({});

  const [channel, setChannel] = useState<Channel>('beauty');
  const [wire, setWire] = useState(0); // 0 关 / 1 黑 / 2 白
  const [iesFog, setIesFog] = useState(0.03);
  const [iesScene, setIesScene] = useState<'studio' | 'wash' | 'cove'>('studio');
  const [iesDist, setIesDist] = useState(0.25);
  const [iesInner, setIesInner] = useState(10);
  const [iesOuter, setIesOuter] = useState(30);
  const [iesHue, setIesHue] = useState(40);
  const [iesSat, setIesSat] = useState(0.12);
  const [iesLight, setIesLight] = useState(0.85);
  const [iesAim, setIesAim] = useState<'down' | 'up' | 'both'>('down');
  const [useCct, setUseCct] = useState(true);
  const [cct, setCct] = useState(6500);
  const [iesRot, setIesRot] = useState(0);
  const iesUiRef = useRef({ scene: iesScene, dist: iesDist, inner: iesInner, outer: iesOuter, hue: iesHue, sat: iesSat, light: iesLight, aim: iesAim, useCct, cct, rot: iesRot });
  iesUiRef.current = { scene: iesScene, dist: iesDist, inner: iesInner, outer: iesOuter, hue: iesHue, sat: iesSat, light: iesLight, aim: iesAim, useCct, cct, rot: iesRot };
  const [uvMode, setUvMode] = useState(false);
  const [split, setSplit] = useState(50);
  const [uvSet, setUvSet] = useState('uv');
  const [udim, setUdim] = useState('all');
  const [activeMat, setActiveMat] = useState(-1);
  const [meshList, setMeshList] = useState<any[]>([]);
  const [matGroups, setMatGroups] = useState<{ name: string; count: number }[]>([]);
  const [tiles, setTiles] = useState<string[]>([]);
  // F-007：模型材质/通道贴图覆盖
  const [ovVersion, setOvVersion] = useState(0);
  const [ovOpen, setOvOpen] = useState(false);
  const [ovMatSel, setOvMatSel] = useState('');
  const [ovChSel, setOvChSel] = useState('baseColor');
  const [ovSwz, setOvSwz] = useState<'rgb' | 'r' | 'g' | 'b' | 'a'>('rgb');
  const [ovFileSel, setOvFileSel] = useState('');

  const [exposure, setExposure] = useState(1);
  const [envI, setEnvI] = useState(1);
  const [keyI, setKeyI] = useState(1.5);
  const keyIRef = useRef(keyI);
  keyIRef.current = keyI;
  const [az, setAz] = useState(-35);
  const [el, setEl] = useState(25);
  const [hdris, setHdris] = useState<any[]>([]);
  const [hdriId, setHdriId] = useState<number | null>(null);
  const [hdriVisible, setHdriVisible] = useState(false);
  const [hdriRot, setHdriRot] = useState(0);
  const [hdriBright, setHdriBright] = useState(1);
  const [texPreview, setTexPreview] = useState<{ src: string; name: string } | null>(null);
  const [groupTex, setGroupTex] = useState<any[][]>([]);
  const [mapUv, setMapUv] = useState(0);
  const [showHdri, setShowHdri] = useState(false);

  const [geom, setGeom] = useState<GeoKind>('sphere');
  const [preset, setPreset] = useState<Preset>(() => {
    const v = localStorage.getItem('am-nav');
    return v === 'max' || v === 'blender' ? v : 'maya';
  });
  const [status, setStatus] = useState('准备中…');
  const [error, setError] = useState<string | null>(null);

  const ui = useRef({ exposure, envI, keyI, az, el, wire, hdriId, hdriRot, hdriBright, hdriVisible });
  ui.current = { exposure, envI, keyI, az, el, wire, hdriId, hdriRot, hdriBright, hdriVisible };
  const isModel = asset.type === 'model' || asset.type === 'scene';
  const isHdri = asset.type === 'hdri';
  const isIes = asset.type === 'ies';

  const iesFogRef = useRef(iesFog);
  iesFogRef.current = iesFog;

  function buildIesWorld() {
    const a: any = api.current;
    if (!a?.scene) return;
    const sc: THREE.Scene = a.scene;
    const U = iesUiRef.current;
    if (a.iesWorld) sc.remove(a.iesWorld);
    if (a.iesTaken) for (const o of a.iesTaken) sc.remove(o);

    const world = new THREE.Group();
    const taken: THREE.Object3D[] = [];
    const ies: any = a.iesFull;
    const outer = Math.min(90, Math.max(0.5, U.outer));
    const inner = Math.min(outer, Math.max(0, U.inner));
    const iesUni = {
      uIesTex: { value: a.iesTex2D },
      uLightPos: { value: new THREE.Vector3(0, 2.3, 0) },
      uIesColor: { value: new THREE.Color().setHSL(U.hue / 360, U.sat, U.light ?? 0.85) },
      uIesIntensity: { value: 0.0025 },
      uMaxPhi: { value: ies ? ies.maxPhi : Math.PI / 2 },
      uMaxTheta: { value: ies ? ies.maxTheta : Math.PI / 2 },
      uIesPeak: { value: ies ? ies.peak : 1 },
      uIesGain: { value: 2.2 },
      uAxis: { value: new THREE.Vector3(0, -1, 0) },
      uBoth: { value: 0 },
      uAzOffset: { value: 0 },
      uInnerRad: { value: (inner / 2) * Math.PI / 180 },
      uOuterRad: { value: (outer / 2) * Math.PI / 180 }
    };
    const surfMat = iesMaterial({ color: 0xcccccc, roughness: 0.94, metalness: 0, side: THREE.DoubleSide }, iesUni);
    const floorMat = surfMat;
    const wallMat = surfMat;
    const y = 2.3;
    const wallZ = 1.2;
    const coveR = 0.6;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    world.add(floor);

    if (U.scene === 'wash' || U.scene === 'cove') {
      const ceilingY = 3.0;
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), floorMat);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = ceilingY;
      ceil.receiveShadow = true;
      world.add(ceil);
      const wallBottom = U.scene === 'cove' ? coveR : 0;
      const wallH = (ceilingY - (U.scene === 'cove' ? coveR : 0)) - wallBottom;
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, wallH), wallMat);
      wall.position.set(0, wallBottom + wallH / 2, wallZ);
      wall.rotation.y = Math.PI; // 墙面朝向房间（-z）
      wall.receiveShadow = true;
      world.add(wall);
      if (U.scene === 'cove') {
        const segU = 24, segX = 2, xw = 6;
        const pos: number[] = [];
        const idx: number[] = [];
        for (let iu = 0; iu <= segU; iu++) {
          const ang = (iu / segU) * Math.PI / 2;
          const py = coveR - coveR * Math.cos(ang);
          const pz = wallZ - coveR + coveR * Math.sin(ang);
          for (let ix = 0; ix <= segX; ix++) {
            pos.push(-xw / 2 + (xw * ix) / segX, py, pz);
          }
        }
        for (let iu = 0; iu < segU; iu++) {
          for (let ix = 0; ix < segX; ix++) {
            const a0 = iu * (segX + 1) + ix;
            const b0 = (iu + 1) * (segX + 1) + ix;
            idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        const cove = new THREE.Mesh(g, wallMat);
        cove.receiveShadow = true;
        world.add(cove);
        // 天花板与墙的圆弧（与地面同半径）
        const pos2: number[] = [];
        const idx2: number[] = [];
        for (let iu = 0; iu <= segU; iu++) {
          const ang = (iu / segU) * Math.PI / 2;
          const py = ceilingY - coveR + coveR * Math.sin(ang);
          const pz = wallZ - coveR + coveR * Math.cos(ang);
          for (let ix = 0; ix <= segX; ix++) {
            pos2.push(-xw / 2 + (xw * ix) / segX, py, pz);
          }
        }
        for (let iu = 0; iu < segU; iu++) {
          for (let ix = 0; ix < segX; ix++) {
            const a0 = iu * (segX + 1) + ix;
            const b0 = (iu + 1) * (segX + 1) + ix;
            idx2.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
          }
        }
        const g2 = new THREE.BufferGeometry();
        g2.setAttribute('position', new THREE.Float32BufferAttribute(pos2, 3));
        g2.setIndex(idx2);
        g2.computeVertexNormals();
        const cove2 = new THREE.Mesh(g2, wallMat);
        cove2.receiveShadow = true;
        world.add(cove2);
      }
    }

    const lightZ = (U.scene === 'wash' || U.scene === 'cove') ? wallZ - Math.max(0.05, U.dist) : 0;
    const fixtureY = (U.scene === 'wash' || U.scene === 'cove') ? 1.5 : y;
    const housing = new THREE.MeshStandardMaterial({ color: 0x33373f, roughness: 0.35, metalness: 0.85 });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff7e8 });
    const fixture = new THREE.Group();
    fixture.position.set(0, fixtureY, lightZ);
    // 灯具：筒身 + 压圈 + 发光面（可朝上/朝下/双向）
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.22, 24), housing);
    body.castShadow = true; fixture.add(body);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.022, 10, 28), housing);
    ring.rotation.x = Math.PI / 2; fixture.add(ring);
    const lensDown = new THREE.Mesh(new THREE.CircleGeometry(0.115, 24), bulbMat);
    lensDown.rotation.x = -Math.PI / 2; lensDown.position.y = -0.115; fixture.add(lensDown);
    if (U.aim === 'up' || U.aim === 'both') {
      const lensUp = new THREE.Mesh(new THREE.CircleGeometry(0.115, 24), bulbMat);
      lensUp.rotation.x = Math.PI / 2; lensUp.position.y = 0.115; fixture.add(lensUp);
    }
    if (U.aim === 'up') {
      body.rotation.x = Math.PI; ring.rotation.x = -Math.PI / 2;
      lensDown.rotation.x = Math.PI / 2; lensDown.position.y = 0.115;
    }

    // 光源位置（IES 逐像素计算用）
    iesUni.uLightPos.value.set(0, fixtureY, lightZ);
    const peakRef = ies ? ies.peak : 10000;
    iesUni.uIesGain.value = 3.4 * Math.min(2.5, Math.max(0.6, Math.sqrt(peakRef / 10000)));
    a.iesGain = iesUni.uIesGain.value;
    iesUni.uIesIntensity.value = iesUni.uIesGain.value * Math.max(0.001, keyIRef.current);
    a.iesUni = iesUni;
    const color = U.useCct ? kelvinToColor(U.cct) : new THREE.Color().setHSL(U.hue / 360, U.sat, U.light ?? 0.85);
    iesUni.uIesColor.value.copy(color);
    // IES 若已覆盖 0..180（上下都有数据），不要再翻转轴向，否则左右会互换
    // 朝向翻转轴时，方位角整体旋转 180°，光瓣保持在墙的同一侧
    iesUni.uAxis.value.set(0, U.aim === 'up' ? 1 : -1, 0);
    iesUni.uBoth.value = U.aim === 'both' ? 1 : 0;
    iesUni.uAzOffset.value = (U.aim === 'up' ? 0.5 : 0) + (U.rot || 0) / 360;
    fixture.rotation.y = ((U.rot || 0) * Math.PI) / 180;

    const angle = Math.min(Math.PI / 2, outer * Math.PI / 360);
    const h = U.aim === 'up' ? 1.2 : Math.max(0.25, fixtureY - 0.12);
    const rad = Math.tan(angle) * h;
    const volMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: color.clone() }, uDensity: { value: 0.05 }, uR: { value: Math.max(0.001, rad) }, uH: { value: h / 2 } },
      vertexShader: 'varying vec3 vL; void main(){ vL = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        uniform vec3 uColor; uniform float uDensity; uniform float uR; uniform float uH; varying vec3 vL;
        void main(){
          float t = clamp((vL.y + uH) / (2.0 * uH), 0.0, 1.0);
          float r = length(vL.xz) / max(0.001, uR * mix(0.12, 1.0, t));
          float edge = 1.0 - smoothstep(0.25, 1.05, r);
          float top = smoothstep(0.0, 0.12, t);
          float falloff = mix(1.0, 0.25, t); // 越靠近地面越淡，避免硬边
          float a = uDensity * pow(edge, 1.6) * top * falloff;
          gl_FragColor = vec4(uColor, a);
        }`
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(Math.max(0.02, rad), h, 32, 1, true), volMat);
    if (U.aim === 'up') { cone.rotation.x = Math.PI; cone.position.set(0, h / 2, 0); }
    else cone.position.set(0, -h / 2, 0);
    fixture.add(cone);

    world.add(fixture);
    sc.add(world);
    floorMat.needsUpdate = true;
    wallMat.needsUpdate = true;
    a.iesAmbBase = (U.scene === 'studio') ? 0.1 : 0.55;
    a.iesScale = (U.scene === 'studio') ? 200 : 60;
    if (a.iesAmbient) a.iesAmbient.intensity = a.iesAmbBase;
    a.iesWorld = world;
    a.iesTaken = taken;
    a.iesLights = [];
    a.iesVolMat = volMat;
    a.iesSpot = null;

    const cam: any = a.camera;
    const sceneChanged = a.iesShownScene !== U.scene;
    a.iesShownScene = U.scene;
    if (cam && sceneChanged) {
      const c: any = a.ctrl;
      if (U.scene === 'studio') {
        cam.position.set(3.0, 2.1, 3.8); cam.lookAt(0, 0.9, 0);
        if (c) { c.target.set(0, 0.9, 0); c.dist = 4.8; c.yaw = 0.55; c.pitch = 0.22; }
      } else {
        // 房间在 -z 一侧，正对墙面
        cam.position.set(0, 1.2, -2.8); cam.lookAt(0, 1.2, 1.2);
        if (c) { c.target.set(0, 1.2, 1.2); c.dist = 4.0; c.yaw = Math.PI; c.pitch = 0; }
      }
    }
  }

  // ---- scene setup ----
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(el.clientWidth || 900, el.clientHeight || 600, true);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0c0e);
    const camera = new THREE.PerspectiveCamera(38, (el.clientWidth || 900) / (el.clientHeight || 600), 0.05, 300);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = roomEnv;

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    rim.position.set(3, 2, -4);
    scene.add(rim);

    const ctrl = { yaw: 0.55, pitch: 0.22, dist: 4.2, target: new THREE.Vector3() };
    const applyCamera = () => {
      const { yaw, pitch, dist, target } = ctrl;
      camera.position.set(
        target.x + dist * Math.cos(pitch) * Math.sin(yaw),
        target.y + dist * Math.sin(pitch),
        target.z + dist * Math.cos(pitch) * Math.cos(yaw)
      );
      camera.lookAt(target);
    };

    let raf = 0;
    const loop = () => {
      if (disposed) return;
      if (api.current.iesTex || api.current.iesSpot) {
        renderer.toneMappingExposure = ui.current.exposure;
        try { key.intensity = 0; rim.intensity = 0; } catch { /* ignore */ }
        const lights = api.current.iesLights || [];
        for (const l of lights) { if (l && l.isLight) l.intensity = 0; }
        api.current.iesAmbient.intensity = ui.current.envI * (api.current.iesAmbBase || 0.1);
        if (scene.fog) (scene.fog as any).density = Math.max(0.0002, iesFogRef.current) * 0.35;
        if (api.current.iesUni && api.current.iesGain) {
          api.current.iesUni.uIesIntensity.value = api.current.iesGain * Math.max(0.001, ui.current.keyI);
        }
        const vm = api.current.iesVolMat;
        if (vm?.uniforms?.uDensity) vm.uniforms.uDensity.value = Math.min(0.35, Math.max(0.001, iesFogRef.current) * 2.0);
      } else if (ui.current.hdriId) {
        renderer.toneMappingExposure = 1;
        key.intensity = 0;
        rim.intensity = 0;
        const rot = (ui.current.hdriRot * Math.PI) / 180;
        scene.environmentIntensity = ui.current.hdriBright;
        scene.environmentRotation.set(0, rot, 0);
        if ((scene.background as any)?.isTexture) {
          scene.backgroundIntensity = ui.current.hdriBright;
          scene.backgroundRotation.set(0, rot, 0);
        }
      } else {
        renderer.toneMappingExposure = ui.current.exposure;
        key.intensity = ui.current.keyI;
        const a = (ui.current.az * Math.PI) / 180;
        const e = (ui.current.el * Math.PI) / 180;
        key.position.set(Math.cos(e) * Math.sin(a) * 7, Math.sin(e) * 7, Math.cos(e) * Math.cos(a) * 7);
        scene.environmentIntensity = ui.current.envI;
        rim.intensity = 0.5;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };

    let drag: any = null;
    const canvas = renderer.domElement;
    const onDown = (ev: PointerEvent) => { drag = { x: ev.clientX, y: ev.clientY, b: ev.button }; canvas.setPointerCapture(ev.pointerId); };
    const onMove = (ev: PointerEvent) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      if (api.current.isPano) {
        const sph = api.current.pano;
        api.current.panoYaw -= dx * 0.004;
        api.current.panoPitch = THREE.MathUtils.clamp(api.current.panoPitch - dy * 0.004, -1.2, 1.2);
        // 环境球使用「相机姿态的逆」，避免先 yaw 后 pitch 造成的翻滚
        const e = new THREE.Euler(api.current.panoPitch, api.current.panoYaw, 0, 'YXZ');
        sph.quaternion.setFromEuler(e).invert();
        return;
      }
      if (drag.b === 1) {
        const s = ctrl.dist * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        ctrl.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
      } else {
        ctrl.yaw -= dx * 0.007;
        ctrl.pitch = Math.max(-1.45, Math.min(1.45, ctrl.pitch + dy * 0.007));
      }
      applyCamera();
    };
    const onUp = () => { drag = null; };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      if (api.current.isPano) {
        camera.fov = Math.max(25, Math.min(95, camera.fov + Math.sign(ev.deltaY) * 3));
        camera.updateProjectionMatrix();
        return;
      }
      ctrl.dist = Math.max(0.6, Math.min(60, ctrl.dist * (1 + Math.sign(ev.deltaY) * 0.08)));
      applyCamera();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
      if (ev.key === 'f' || ev.key === 'F') {
        if (api.current.isPano) return;
        ctrl.dist = 4.2; ctrl.yaw = 0.55; ctrl.pitch = 0.22; ctrl.target.set(0, 0, 0); applyCamera();
      }
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', onKey);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w && h) { renderer.setSize(w, h, true); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    });
    ro.observe(el);

    api.current = { renderer, scene, camera, key, roomEnv, ctrl, applyCamera, setMaterial: null, setGeom: null, baseMat: null, meshes: [] };
    (window as any).__viewer = api.current;
    applyCamera();
    loop();

    (async () => {
      const files = asset.files;
      // 统一走 matlib.loadTexture：TIFF/TGA 会先解码成 PNG，失败也有占位贴图兜底
      const tex = (f: AssetFile, srgb = false) => loadTexture(f, srgb);

      // UDIM 分块文件（xxx_1001.jpg / xxx.1002.jpg …）合成为一张图集
      const udimAtlas = async (list: AssetFile[], keys: string[], srgb = false): Promise<THREE.Texture | null> => {
        const re = /^(.*?)[._-](\d{4})\.(png|jpe?g|tga|tiff?)$/i;
        const sets = new Map<string, { num: number; file: AssetFile }[]>();
        for (const f of list) {
          const m = f.rel_path.match(re);
          if (!m) continue;
          const num = Number(m[2]);
          if (num < 1001 || num > 1999) continue;
          const baseName = m[1].toLowerCase();
          if (keys.length && !keys.some(k => baseName.includes(k))) continue;
          const arr = sets.get(baseName) || [];
          arr.push({ num, file: f });
          sets.set(baseName, arr);
        }
        if (!sets.size) return null;
        const tiles = [...sets.values()].sort((a, b) => b.length - a.length)[0];
        if (tiles.length < 2) return null;
        let cols = 1, rows = 1;
        for (const t of tiles) {
          const i = t.num - 1001;
          cols = Math.max(cols, (i % 10) + 1);
          rows = Math.max(rows, Math.floor(i / 10) + 1);
        }
        const load = (id: number) => new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = `/api/file/${id}`;
        });
        const first = await load(tiles[0].file.id);
        const w = first.naturalWidth || first.width;
        const h = first.naturalHeight || first.height;
        const canvas = document.createElement('canvas');
        canvas.width = w * cols;
        canvas.height = h * rows;
        const c2 = canvas.getContext('2d')!;
        const place = (img: HTMLImageElement, num: number) => {
          const i = num - 1001, u = i % 10, v = Math.floor(i / 10);
          c2.drawImage(img, u * w, (rows - 1 - v) * h, w, h);
        };
        place(first, tiles[0].num);
        await Promise.all(tiles.slice(1).map(async t => {
          try { place(await load(t.file.id), t.num); } catch { /* skip */ }
        }));
        const out = new THREE.CanvasTexture(canvas);
        out.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        out.anisotropy = 8;
        out.wrapS = out.wrapT = THREE.ClampToEdgeWrapping;
        out.needsUpdate = true;
        return out;
      };

      const packed = findFile(files, '_arm_', '_orm_', '_omr_', '_rma_');
      const base = findFile(files, 'basecolor', 'base_color', 'albedo', 'diffuse', '_diff', 'color');
      const normal = findFile(files, 'normal', 'nor_gl', 'nor_dx', '_nrm');
      const rough = findFile(files, 'roughness', 'rough');
      const metal = findFile(files, 'metallic', 'metal');
      const ao = findFile(files, '_ao', 'ambient', 'occlusion');
      const height = findFile(files, 'height', 'displacement', '_disp');
      const emis = findFile(files, 'emissive', 'emission', 'emit');

      setStatus('加载贴图…');
      const mat = new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 0 });
      const uBase = await udimAtlas(files, ['diff', 'albedo', 'basecolor', 'color'], true);
      const uNor = await udimAtlas(files, ['nor', 'normal']);
      const uRough = await udimAtlas(files, ['rough']);
      const uMetal = await udimAtlas(files, ['metal']);
      const uAo = await udimAtlas(files, ['_ao', 'occlusion']);
      const uEmis = await udimAtlas(files, ['emit', 'emissive'], true);
      try {
        if (uBase) mat.map = uBase; else if (base) mat.map = await tex(base, true);
        if (uNor) {
          mat.normalMap = uNor;
        } else if (normal) {
          mat.normalMap = await tex(normal);
          if (/(_dx|dx_|directx)/i.test(lc(normal))) mat.normalScale.set(1, -1);
        }
        if (uRough) mat.roughnessMap = uRough; else if (rough) mat.roughnessMap = await tex(rough);
        if (uMetal) { mat.metalnessMap = uMetal; mat.metalness = 1; }
        else if (metal) { mat.metalnessMap = await tex(metal); mat.metalness = 1; }
        if (uAo) mat.aoMap = uAo; else if (ao) mat.aoMap = await tex(ao);
        if (height) { mat.displacementMap = await tex(height); mat.displacementScale = 0.05; }
        if (uEmis) { mat.emissiveMap = uEmis; mat.emissive = new THREE.Color(0xffffff); }
        else if (emis) { mat.emissiveMap = await tex(emis, true); mat.emissive = new THREE.Color(0xffffff); }
        if (packed) {
          const t = await tex(packed);
          mat.aoMap = t; mat.roughnessMap = t; mat.metalnessMap = t; mat.metalness = 1;
          const name = lc(packed);
          if (name.includes('omr') || name.includes('rma')) {
            mat.onBeforeCompile = (shader) => {
              shader.fragmentShader = shader.fragmentShader
                .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;
                  #ifdef USE_ROUGHNESSMAP
                    vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
                    roughnessFactor *= texelRoughness.${name.includes('omr') ? 'b' : 'r'};
                  #endif`)
                .replace('#include <metalnessmap_fragment>', `float metalnessFactor = metalness;
                  #ifdef USE_METALNESSMAP
                    vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
                    metalnessFactor *= texelMetalness.${name.includes('omr') ? 'g' : 'b'};
                  #endif`);
            };
            mat.customProgramCacheKey = () => 'packed-' + (name.includes('omr') ? 'omr' : 'rma');
          }
        }
      } catch (e: any) { setError('贴图加载失败：' + (e?.message || e)); }

      if (asset.type === 'hdri') {
        const hf = findFile(files, '.exr', '.hdr');
        if (!hf) { setError('没有 .hdr/.exr 文件'); setStatus(''); return; }
        setStatus('加载 HDRI…');
        const isExr = /\.exr$/i.test(hf.rel_path);
        const loader = isExr ? new EXRLoader() : new RGBELoader();
        const tex = await loader.loadAsync(`/api/file/${hf.id}`);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(40, 96, 48),
          new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide })
        );
        sphere.rotation.order = 'YXZ'; // yaw + pitch，禁止 roll
        scene.add(sphere);
        api.current.pano = sphere;
        api.current.isPano = true;
        api.current.panoYaw = 0;
        api.current.panoPitch = 0;
        api.current.meshes = [];
        setMeshList([]);
        camera.position.set(0, 0, 0);
        camera.rotation.set(0, 0, 0);
        camera.lookAt(0, 0, -1);
        scene.background = new THREE.Color(0x000000);
        setStatus('');
        return;
      }

      if (asset.type === 'ies') {
        const iesFile = findFile(files, '.ies', '.ldt');
        if (!iesFile) { setError('没有 .ies / .ldt 灯光文件'); setStatus(''); return; }
        setStatus('解析 IES…');
        let full: any = null;
        try {
          const txt = await (await fetch(`/api/file/${iesFile.id}`)).text();
          full = parseIesFull(txt);
        } catch { /* ignore */ }
        if (!full) {
          setError(String(iesFile.rel_path).toLowerCase().endsWith('.ldt')
            ? '暂时不支持 .ldt 预览（EULUMDAT 解析未实现），请用 .ies 文件'
            : 'IES 解析失败（文件可能不是 IESNA 格式）');
          setStatus('');
          return;
        }
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        scene.environment = null;
        const ambient = new THREE.AmbientLight(0xffffff, 0.32);
        scene.add(ambient);
        api.current.iesAmbient = ambient;
        api.current.iesFull = full;
        api.current.iesTex2D = ies360Texture(full);
        api.current.iesTex = api.current.iesTex2D;
        // 用 IES 实际配光推默认锥角（半角×2 = 全角）
        let half = full.ver[full.ver.length - 1] || 30;
        for (let k = 1; k < full.cd.length; k++) {
          if ((full.cd[k][0] || 0) <= full.peak * 0.1) { half = full.ver[k]; break; }
        }
        const defOuter = Math.max(2, Math.min(90, Math.round(half * 2)));
        const defInner = Math.max(0, Math.min(90, Math.round(half)));
        setIesOuter(defOuter);
        setIesInner(defInner);
        api.current.iesDefInner = defInner;
        api.current.iesDefOuter = defOuter;
        try { key.intensity = 0; rim.intensity = 0; } catch { /* ignore */ }
        scene.fog = new THREE.FogExp2(0x0d0f13, Math.max(0.001, iesFogRef.current));
        buildIesWorld();
        api.current.meshes = [];
        setMatGroups([]);
        camera.position.set(3.0, 2.1, 3.8);
        camera.lookAt(0, 1.1, 0);
        ctrl.target.set(0, 0.9, 0);
        ctrl.dist = 4.8;
        setStatus('');
        return;
      }

      if (isModel) {
        const extOf = (p: string) => (String(p).match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
        const modelFile = files.find(f => /\.(fbx|obj|glb|gltf)$/i.test(f.rel_path) && f.role === 'model')
          || files.find(f => /\.(fbx|obj|glb|gltf)$/i.test(f.rel_path));
        if (!modelFile) { setError('没有可预览的模型文件'); setStatus(''); return; }
        const mext = extOf(modelFile.rel_path);
        // F-004：OBJ/GLB/GLTF 的相对资源（mtl、bin、贴图）按同目录文件名映射到 /api/file/:id
        const fileByName = new Map<string, number>();
        for (const f of files) {
          const bn = String(f.rel_path).split('/').pop();
          if (bn) fileByName.set(bn.toLowerCase(), f.id);
        }
        // TIFF / TGA 贴图先解码成 PNG blob（浏览器原生解码不了）
        const special = await preloadSpecialTextures(files);
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(url => {
          if (/^(data:|blob:|https?:)/i.test(url)) return url;
          let name = url;
          try { name = decodeURIComponent(url.split('?')[0]); } catch { /* keep */ }
          name = name.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
          const sp = special.get(name);
          if (sp) return sp;
          const id = fileByName.get(name);
          return id ? `/api/file/${id}` : url;
        });
        setStatus('解析模型…');
        let obj: any;
        if (mext === '.fbx') {
          await assertBinaryFbx(modelFile.id, modelFile.rel_path);
          obj = await new Promise<THREE.Group>((res, rej) => new FBXLoader(manager).load(`/api/file/${modelFile.id}`, res, undefined, rej));
        } else if (mext === '.obj') {
          const mtl = files.find(f => /\.mtl$/i.test(f.rel_path));
          const loader = new OBJLoader(manager);
          if (mtl) {
            const mtlLoader = new MTLLoader(manager);
            const mats: any = await new Promise((res, rej) => mtlLoader.load(`/api/file/${mtl.id}`, res, undefined, rej));
            if (mats?.preload) mats.preload();
            loader.setMaterials(mats);
          }
          obj = await new Promise<any>((res, rej) => loader.load(`/api/file/${modelFile.id}`, res, undefined, rej));
        } else {
          const gl: any = await new Promise((res, rej) => new GLTFLoader(manager).load(`/api/file/${modelFile.id}`, res, undefined, rej));
          obj = gl.scene || gl.scenes?.[0];
        }
        const collected: any[] = [];
        const fileNameOf = (src: string) => {
          try { return decodeURIComponent(String(src).split('/').pop() || ''); } catch { return ''; }
        };
        const baseKey = (material: any) => {
          const m = Array.isArray(material) ? material[0] : material;
          const nm = String(m?.name || '').trim();
          if (nm && nm !== '__DEFAULT') return 'n:' + nm;
          const src = m?.map?.image?.src;
          if (src) return 't:' + src;
          return 'shared';
        };
        obj.traverse((o: any) => {
          if (o.isMesh) {
            const orig = o.material;
            const first = Array.isArray(orig) ? orig[0] : orig;
            const hasOwn = !!(first && (first.map || first.emissiveMap));
            const key = hasOwn ? baseKey(orig) : 'shared';
            collected.push({
              mesh: o, key, kept: hasOwn,
              matName: (first?.name && first.name !== '__DEFAULT' ? first.name : fileNameOf(first?.map?.image?.src || '')) || `Mesh ${collected.length + 1}`,
              ownMat: hasOwn ? orig : mat
            });
            if (o.geometry?.attributes?.uv && !o.geometry.attributes.uv1) o.geometry.setAttribute('uv1', o.geometry.attributes.uv);
            // 模型自带贴图时保留原始材质，避免多材质模型全部套同一张贴图
            if (!hasOwn) o.material = mat;
          }
        });
        // 按材质对象/贴图归组（空名字的不同材质也能分开）
        const gmap = new Map<string, any[]>();
        for (const c of collected) {
          const arr = gmap.get(c.key) || [];
          arr.push(c);
          gmap.set(c.key, arr);
        }
        // 无自带贴图的组：按材质名匹配同名贴图
        for (const [key, list] of gmap) {
          if (key === 'shared') continue;
          const c0 = list[0];
          const nm = String(c0.matName || '');
          const norm = nm.toLowerCase().replace(/[^a-z0-9]/g, '');
          const sub = files.filter(f => {
            const n = f.rel_path.toLowerCase().replace(/[^a-z0-9]/g, '');
            return norm.length >= 3 && n.includes(norm);
          });
          if (!sub.some(f => /\.(png|jpe?g|tga|tiff?)$/i.test(f.rel_path))) continue;
          const m = mat.clone();
          const uBase2 = await udimAtlas(sub, ['diff', 'albedo', 'basecolor', 'color'], true);
          const base = findFile(sub, 'basecolor', 'base_color', 'albedo', 'diffuse', '_diff', 'color');
          if (uBase2) m.map = uBase2; else if (base) m.map = await tex(base, true);
          const nor = findFile(sub, 'normal', '_nrm');
          if (nor) m.normalMap = await tex(nor);
          const rr = findFile(sub, 'roughness', 'rough');
          if (rr) m.roughnessMap = await tex(rr);
          const mm = findFile(sub, 'metallic', 'metal');
          if (mm) { m.metalnessMap = await tex(mm); m.metalness = 1; }
          const aa = findFile(sub, '_ao', 'occlusion');
          if (aa) m.aoMap = await tex(aa);
          m.needsUpdate = true;
          for (const c of list) { c.mesh.material = m; c.ownMat = m; }
        }
        // UDIM：UV 超出 0–1 时按贴图内容决定「图集缩放」还是「单块平铺」
        const isAtlasTexture = (img: any): boolean => {
          try {
            const c = document.createElement('canvas');
            c.width = 64; c.height = 64;
            const cx = c.getContext('2d')!;
            cx.drawImage(img, 0, 0, 64, 64);
            const d = cx.getImageData(0, 0, 64, 64).data;
            let sum = 0, n = 0;
            for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) {
              const i = (y * 64 + x) * 4, j = (y * 64 + x + 32) * 4;
              sum += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
              n += 3;
            }
            return sum / n > 20;
          } catch { return true; }
        };
        for (const [, list] of gmap) {
          let maxU = 0, maxV = 0;
          for (const c of list) {
            const attr = c.mesh.geometry?.attributes?.uv;
            if (!attr) continue;
            for (let i = 0; i < attr.count; i += 11) {
              maxU = Math.max(maxU, attr.getX(i));
              maxV = Math.max(maxV, attr.getY(i));
            }
          }
          const ru = Math.max(1, Math.ceil(maxU - 0.001));
          const rv = Math.max(1, Math.ceil(maxV - 0.001));
          if (ru === 1 && rv === 1) continue;
          const m: any = Array.isArray(list[0].mesh.material) ? list[0].mesh.material[0] : list[0].mesh.material;
          const maps = [m?.map, m?.normalMap, m?.roughnessMap, m?.metalnessMap, m?.aoMap, m?.emissiveMap];
          for (const t of maps) {
            if (!t) continue;
            const atlas = t.image ? isAtlasTexture(t.image) : true;
            if (atlas) {
              t.wrapS = THREE.ClampToEdgeWrapping;
              t.wrapT = THREE.ClampToEdgeWrapping;
              t.repeat.set(1 / ru, 1 / rv);
            } else {
              // 单块贴图 + UDIM UV：每个 UDIM 格重复同一张贴图
              t.wrapS = THREE.RepeatWrapping;
              t.wrapT = THREE.RepeatWrapping;
              t.repeat.set(1, 1);
            }
            t.offset.set(0, 0);
            t.needsUpdate = true;
          }
          if (m) m.needsUpdate = true;
        }
        // F-007：应用手动指定的贴图覆盖（按材质名 + 通道）
        let ovMap: Record<string, Record<string, { rel: string; swizzle?: string }>> = {};
        try {
          const r = await fetch(`/api/model/${asset.id}/overrides`).then(x => x.json());
          const raw = r?.overrides || {};
          for (const [m, chans] of Object.entries<any>(raw)) {
            ovMap[m] = {};
            for (const [ch, v] of Object.entries<any>(chans)) {
              ovMap[m][ch] = typeof v === 'string' ? { rel: v, swizzle: 'rgb' } : v;
            }
          }
        } catch { /* ignore */ }
        if (Object.keys(ovMap).length) {
          const bake = (tex: THREE.Texture, comp: string): THREE.Texture => {
            const img: any = tex.image;
            const w = img?.naturalWidth || img?.width || 0;
            const h = img?.naturalHeight || img?.height || 0;
            if (!w || !h) return tex;
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const c = cv.getContext('2d')!;
            c.drawImage(img, 0, 0);
            const d = c.getImageData(0, 0, w, h);
            const idx = comp === 'r' ? 0 : comp === 'g' ? 1 : comp === 'b' ? 2 : 3;
            for (let i = 0; i < d.data.length; i += 4) {
              const v = d.data[i + idx];
              d.data[i] = v; d.data[i + 1] = v; d.data[i + 2] = v; d.data[i + 3] = 255;
            }
            c.putImageData(d, 0, 0);
            const t = new THREE.CanvasTexture(cv);
            t.colorSpace = THREE.NoColorSpace;
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = 8;
            return t;
          };
          const loadOv = async (rel: string, srgb: boolean, swz = 'rgb') => {
            const f = files.find(x => String(x.rel_path) === rel);
            let url = f ? `/api/file/${f.id}` : `/api/override-file?assetId=${asset.id}&rel=${encodeURIComponent(rel)}`;
            if (f && SPECIAL_TEX.test(f.rel_path)) {
              const u = await specialTextureUrl(f);
              if (u) url = u;
            }
            return new Promise<THREE.Texture>((res, rej) => {
            const f = files.find(x => String(x.rel_path) === rel);
            let url = f ? `/api/file/${f.id}` : `/api/override-file?assetId=${asset.id}&rel=${encodeURIComponent(rel)}`;
            new THREE.TextureLoader().load(url, t => {
              t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
              t.wrapS = THREE.RepeatWrapping;
              t.wrapT = THREE.RepeatWrapping;
              t.anisotropy = 8;
              res(swz && swz !== 'rgb' ? bake(t, swz) : t);
            }, undefined, rej);
            });
          };
          for (const c of collected) {
            const ov = ovMap[c.matName];
            if (!ov || !Object.keys(ov).length) continue;
            const baseMat: any = Array.isArray(c.mesh.material) ? c.mesh.material[0] : c.mesh.material;
            if (!baseMat) continue;
            const cl: any = baseMat.clone();
            for (const [ch, ent] of Object.entries(ov)) {
              try {
                const rel = ent.rel;
                const swz = ent.swizzle || 'rgb';
                if (ch === 'baseColor') cl.map = await loadOv(rel, true, swz);
                else if (ch === 'normal') cl.normalMap = await loadOv(rel, false, swz);
                else if (ch === 'roughness') { cl.roughnessMap = await loadOv(rel, false, swz); cl.roughness = 1; }
                else if (ch === 'metallic') { cl.metalnessMap = await loadOv(rel, false, swz); cl.metalness = 1; }
                else if (ch === 'ao') cl.aoMap = await loadOv(rel, false, swz);
                else if (ch === 'emissive') { cl.emissiveMap = await loadOv(rel, true, swz); cl.emissive = new THREE.Color(0xffffff); }
                else if (ch === 'height') { cl.displacementMap = await loadOv(rel, false, swz); cl.displacementScale = 0.02; }
                else if (ch === 'opacity') { cl.alphaMap = await loadOv(rel, false, swz); cl.transparent = true; }
              } catch { /* keep original channel */ }
            }
            cl.needsUpdate = true;
            c.mesh.material = cl;
            c.ownMat = cl;
          }
        }
        const box = new THREE.Box3().setFromObject(obj);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const s = 2.4 / Math.max(size.x, size.y, size.z);
        obj.scale.setScalar(s);
        obj.position.sub(center.multiplyScalar(s));
        obj.position.y += (size.y * s) / 2;
        scene.add(obj);
        api.current.meshes = collected;
        const gs = [...gmap.entries()].map(([key, meshes], i) => ({
          name: meshes[0].matName || `材质 ${i + 1}`,
          meshes
        }));
        api.current.groups = gs;
        setMatGroups(gs.map(g => ({ name: g.name, count: g.meshes.length })));
        // 每个材质组的贴图（用于右侧随材质切换）
        const texInfo = (src: string) => {
          const idm = String(src || '').match(/\/api\/file\/(\d+)/);
          const id = idm ? Number(idm[1]) : 0;
          const f = id ? asset.files.find(x => x.id === id) : undefined;
          return { src, id, name: f ? String(f.rel_path).split('/').pop()! : fileNameOf(src) };
        };
        const groupTex = gs.map(g => {
          const mm: any = Array.isArray(g.meshes[0].mesh.material) ? g.meshes[0].mesh.material[0] : g.meshes[0].mesh.material;
          const rows: any[] = [];
          const seen = new Set<string>();
          const add = (k: string, t: any) => {
            const s2 = t?.image?.src;
            if (!s2 || seen.has(s2)) return;
            seen.add(s2);
            rows.push({ k, ...texInfo(s2) });
          };
          add('baseColor', mm?.map); add('normal', mm?.normalMap); add('roughness', mm?.roughnessMap);
          add('metallic', mm?.metalnessMap); add('ao', mm?.aoMap); add('emissive', mm?.emissiveMap);
          return rows;
        });
        api.current.groupTex = groupTex;
        setGroupTex(groupTex);
        const tset = new Set<string>();
        for (const c of collected) {
          const attr = c.mesh.geometry?.attributes?.uv;
          if (!attr) continue;
          for (let i = 0; i < attr.count; i += 23) tset.add(`${Math.floor(attr.getX(i))},${Math.floor(attr.getY(i))}`);
        }
        setTiles([...tset].sort());
        ctrl.target.set(0, 0, 0);
        ctrl.dist = 4.6;
      } else {
        const ball = new THREE.Mesh(makeGeometry('sphere'), mat);
        scene.add(ball);
        api.current.ball = ball;
        api.current.meshes = [{ mesh: ball, matName: '材质球' }];
        api.current.groups = [{ name: '材质球', meshes: api.current.meshes }];
        setMatGroups([{ name: '材质球', count: 1 }]);
        setTiles(['0,0']);
        ctrl.dist = 3.6;
      }

      api.current.baseMat = mat;
      api.current.setMaterial = (m: THREE.Material) => {
        for (const c of api.current.meshes) c.mesh.material = m;
      };
      api.current.restoreMaterials = () => {
        for (const c of api.current.meshes) c.mesh.material = c.ownMat || mat;
      };
      // FBX 自带贴图可能加载失败（map 存在但 image 为空），此时回退到组装材质，避免全黑
      setTimeout(() => {
        let changed = false;
        for (const c of api.current.meshes as any[]) {
          if (!c.kept) continue;
          const mm: any = c.mesh.material;
          const img: any = mm?.map?.image;
          const ok = img && ((img.width || img.height) || img.data);
          if (!ok) {
            c.mesh.material = mat;
            c.ownMat = mat;
            c.kept = false;
            changed = true;
          } else if (mm.map) {
            mm.map.colorSpace = THREE.SRGBColorSpace;
            mm.needsUpdate = true;
          }
        }
        if (changed) api.current.restoreMaterials?.();
      }, 1200);
      api.current.setGeom = (kind: GeoKind) => {
        const b = api.current.ball; if (!b) return;
        const ng = makeGeometry(kind);
        b.geometry.dispose();
        b.geometry = ng;
      };
      setMeshList([...api.current.meshes]);
      applyCamera();
      setStatus('');
    })().catch(e => { setError(String(e?.message || e)); setStatus(''); });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      renderer.dispose();
      el.innerHTML = '';
    };
  }, [asset.id, ovVersion]);

  // channel material
  useEffect(() => {
    const m = api.current.baseMat;
    if (!m || !api.current.setMaterial) return;
    if (channel === 'beauty') api.current.restoreMaterials?.();
    else api.current.setMaterial(channelMaterial(channel, m));
  }, [channel, asset.id, meshList.length]);

  // geometry
  useEffect(() => { api.current.setGeom?.(geom); }, [geom, asset.id]);

  useEffect(() => {
    const sc: any = api.current.scene;
    if (sc?.fog) sc.fog.density = Math.max(0.001, iesFog);
  }, [iesFog]);

  useEffect(() => {
    if (api.current.iesTex) buildIesWorld();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iesScene, iesDist, iesInner, iesOuter, iesHue, iesSat, iesLight, iesAim, useCct, cct, iesRot]);

  // wireframe overlay
  useEffect(() => {
    const meshes = api.current.meshes || [];
    for (const c of meshes) {
      if (!c.wire) {
        const w = new THREE.LineSegments(
          new THREE.WireframeGeometry(c.mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.95 })
        );
        c.mesh.add(w);
        c.wire = w;
      }
      c.wire.visible = wire > 0;
      c.wire.material.color.set(wire === 2 ? 0xffffff : 0x000000);
    }
  }, [wire, meshList]);

  // hdri list
  useEffect(() => {
    (async () => {
      try {
        const st = await apiJson('/api/state');
        const lib = st.libraries?.[0];
        if (!lib) return;
        const r = await apiJson(`/api/assets?lib=${lib.id}&type=hdri&limit=50`);
        setHdris(r.assets || []);
      } catch { /* ignore */ }
    })();
  }, []);

  // hdri apply
  useEffect(() => {
    let cancelled = false;
    const scene = api.current.scene as THREE.Scene | undefined;
    if (!scene) return;
    (async () => {
      if (!hdriId) {
        scene.environment = api.current.roomEnv;
        if (hdriVisible) scene.background = new THREE.Color(0x15181d);
        else scene.background = new THREE.Color(0x0b0c0e);
        return;
      }
      setStatus('加载 HDRI…');
      try {
        const d = await apiJson(`/api/asset/${hdriId}`);
        const f = (d.files || []).find((x: any) => /\.(hdr|exr)$/i.test(x.rel_path));
        if (!f) return;
        const isExr = /\.exr$/i.test(f.rel_path);
        const loader = isExr ? new EXRLoader() : new RGBELoader();
        const texture = await loader.loadAsync(`/api/file/${f.id}`);
        if (cancelled) return;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const pm = new THREE.PMREMGenerator(api.current.renderer);
        scene.environment = pm.fromEquirectangular(texture).texture;
        pm.dispose();
        scene.background = hdriVisible ? texture : new THREE.Color(0x0b0c0e);
      } catch (e: any) { setError('HDRI 加载失败：' + (e?.message || e)); } finally { if (!cancelled) setStatus(''); }
    })();
    return () => { cancelled = true; };
  }, [hdriId, hdriVisible]);

  // 贴图使用的 UV 通道（uv / uv1 / uv2 …）
  useEffect(() => {
    const m = api.current.baseMat as THREE.MeshPhysicalMaterial | null;
    if (!m) return;
    const maps = [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap, m.displacementMap, m.alphaMap];
    for (const t of maps) {
      if (!t) continue;
      (t as any).channel = mapUv;
      t.needsUpdate = true;
    }
    m.needsUpdate = true;
  }, [mapUv, meshList.length]);

  // uv canvas
  const uvNames = useMemo(() => {
    const set = new Set<string>();
    for (const m of meshList) {
      for (const n of ['uv', 'uv1', 'uv2', 'uv3']) if (m.mesh?.geometry?.attributes?.[n]) set.add(n);
    }
    if (!set.size) set.add('uv');
    return [...set];
  }, [meshList]);

  useEffect(() => {
    if (!uvMode) return;
    const cv = uvCanvas.current;
    if (!cv) return;
    const pane = cv.parentElement as HTMLElement;
    const w = pane.clientWidth, h = pane.clientHeight;
    const dpr = Math.min(devicePixelRatio, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = '100%'; cv.style.height = '100%';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, w, h);
    const meshes = api.current.meshes || [];
    const groups = api.current.groups || [];
    const tile = udim === 'all' ? null : udim.split(',').map(Number);

    const drawGroup = (list: any[], cx: number, cy: number, cs: number, label?: string) => {
      ctx.strokeStyle = 'rgba(120,170,255,.62)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(cx, cy, cs, cs);
      for (const item of list) {
        const g = item.mesh.geometry;
        const attr = g.attributes[uvSet];
        if (!attr) continue;
        const idx = g.index;
        const tri = idx ? idx.count / 3 : attr.count / 3;
        for (let t = 0; t < tri; t++) {
          const ia = idx ? idx.getX(t * 3) : t * 3;
          const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
          const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          let ua = attr.getX(ia), va = attr.getY(ia);
          const ub = attr.getX(ib), vb = attr.getY(ib);
          const uc = attr.getX(ic), vc = attr.getY(ic);
          if (tile) {
            if (Math.floor((ua + ub + uc) / 3) !== tile[0] || Math.floor((va + vb + vc) / 3) !== tile[1]) continue;
            ua -= tile[0]; va -= tile[1];
          }
          const du = tile ? tile[0] : 0, dv = tile ? tile[1] : 0;
          ctx.beginPath();
          ctx.moveTo(cx + ua * cs, cy + (1 - va) * cs);
          ctx.lineTo(cx + (ub - du) * cs, cy + (1 - (vb - dv)) * cs);
          ctx.lineTo(cx + (uc - du) * cs, cy + (1 - (vc - dv)) * cs);
          ctx.closePath();
          ctx.stroke();
        }
      }
      if (label) {
        ctx.fillStyle = 'rgba(200,210,225,.85)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(label, cx, cy - 6);
      }
    };

    const multi = groups.length > 1 && activeMat < 0;
    if (!multi) {
      const list = activeMat >= 0 && groups[activeMat] ? groups[activeMat].meshes : meshes;
      const size = Math.min(w, h) * 0.8;
      drawGroup(list, (w - size) / 2, (h - size) / 2 + 8, size, activeMat >= 0 ? groups[activeMat].name : undefined);
    } else {
      const pad = 16, gap = 14;
      const cols = Math.ceil(Math.sqrt(groups.length));
      const rows = Math.ceil(groups.length / cols);
      const cellW = (w - pad * 2 - gap * (cols - 1)) / cols;
      const cellH = (h - pad * 2 - gap * (rows - 1)) / rows;
      const cs = Math.max(40, Math.min(cellW, cellH) - 24);
      groups.forEach((grp: any, i: number) => {
        const cx = pad + (i % cols) * (cellW + gap);
        const cy = pad + Math.floor(i / cols) * (cellH + gap) + 18;
        drawGroup(grp.meshes, cx, cy, cs, grp.name);
      });
    }
  }, [uvMode, uvSet, udim, activeMat, split, meshList]);

  function startSplit(e: any) {
    e.preventDefault();
    const stage = document.querySelector('.vx-stage') as HTMLElement;
    const move = (ev: any) => {
      const r = stage.getBoundingClientRect();
      const pct = ((ev.clientX - r.left) / r.width) * 100;
      setSplit(Math.max(25, Math.min(75, pct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const cfg = useMemo(() => detectConfig(asset.files, asset.slotMap), [asset.files, asset.slotMap]);
  const textureRows = Object.entries(cfg.channels)
    .map(([k, v]: any) => {
      const f = asset.files.find(x => x.id === v?.fileId);
      return f ? { k, id: f.id, src: `/api/file/${f.id}`, name: String(f.rel_path).split('/').pop() } : null;
    })
    .filter(Boolean) as { k: string; id: number; src: string; name: string }[];
  const shownTex = activeMat >= 0 && groupTex[activeMat] ? groupTex[activeMat] : textureRows;

  async function saveOverride() {
    if (!ovMatSel) return;
    await fetch(`/api/model/${asset.id}/overrides`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ material: ovMatSel, channel: ovChSel, fileRel: ovFileSel, swizzle: ovSwz })
    });
    setOvOpen(false);
    setOvVersion(v => v + 1);
  }

  return (
    <div className="vx">
      <header className="vhead">
        <button className="btn" onClick={onClose}>← 返回网格</button>
        <div className="vtitle"><b>{asset.name}</b><span>{asset.type} · {asset.ext.replace('.', '').toUpperCase()}</span></div>
        <div className="vright">
          {variants && variants.length > 1 && (
            <div className="seg" style={{ marginRight: 8 }}>
              {variants.filter(v => v.lod != null).map(v => (
                <button key={v.id} className={v.id === asset.id ? 'on' : ''} onClick={() => onVariant?.(v.id)}>LOD{v.lod}</button>
              ))}
            </div>
          )}
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </header>

      <div className="vx-body">
        {!isHdri && !isIes && (
          <div className="vx-rail">
          {CHANNEL_META.map(c => (
            <button key={c.key} title={c.label}
              className={'ci ci-' + c.key + (channel === c.key ? ' on' : '')}
              onClick={() => setChannel(c.key)} />
          ))}
          <div className="rail-sep" />
          <button title={`线框：${wire === 0 ? '关' : wire === 1 ? '黑色' : '白色'}（点击切换）`}
            className={'ci ci-wire' + (wire > 0 ? ' on' : '')}
            onClick={() => setWire(w => (w + 1) % 3)} />
          <button title="UV 视口" className={'ci ci-uv' + (uvMode ? ' on' : '')} onClick={() => setUvMode(v => !v)} />
          </div>
        )}

        <div className="vx-stage">
          <div className="vx-3d" ref={stageRef} style={{ flexBasis: uvMode ? `${split}%` : '100%' }}>
            {status && <div className="vloading">{status}</div>}
            {error && <div className="verror">{error}</div>}
          </div>
          {uvMode && <>
            <div className="vx-split" onPointerDown={startSplit} />
            <div className="vx-uv" style={{ flexBasis: `${100 - split}%` }}>
              <div className="vx-uv-bar">
                <span className="vlabel">UV 集</span>
                <select className="sortsel" value={uvSet} onChange={e => setUvSet(e.target.value)}>
                  {uvNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <span className="vlabel">UDIM</span>
                <button className={'chip' + (udim === 'all' ? ' on' : '')} style={{ height: 22 }} onClick={() => setUdim('all')}>全部</button>
                {tiles.map(t => (
                  <button key={t} className={'chip' + (udim === t ? ' on' : '')} style={{ height: 22 }} onClick={() => setUdim(t)}>{t}</button>
                ))}
              </div>
              <canvas ref={uvCanvas} className="uvcanvas2" />
            </div>
          </>}
        </div>

        <aside className={'vx-panel' + (isHdri ? ' minimal' : '')}>
          <div className={'vp-sec' + (hdriId ? ' off' : '')}>
            <div className="vp-t">{isIes ? '场景' : '光照'} {hdriId ? '（HDRI 接管）' : ''}</div>
            {isIes && (
              <div className="vp-row" style={{ flexWrap: 'wrap', height: 'auto' }}>
                <span>类型</span>
                {([['studio', '地面'], ['wash', '洗墙'], ['cove', '无影墙']] as const).map(([k, label]) => (
                  <button key={k} className={'btn tiny' + (iesScene === k ? ' primary' : '')} onClick={() => {
                    setIesScene(k);
                    // 进入洗墙/无影墙：正面平视、无雾、射灯参数回默认
                    setIesFog(k === 'studio' ? 0.03 : 0);
                    setIesDist(0.25);
                    setIesInner(api.current.iesDefInner ?? 10);
                    setIesOuter(api.current.iesDefOuter ?? 30);
                    setKeyI(1.5);
                    setIesHue(40);
                    setIesSat(0.12);
                    setIesLight(0.85);
                  }}>{label}</button>
                ))}
              </div>
            )}
            {isIes && (
              <div className="vp-row" style={{ flexWrap: 'wrap', height: 'auto' }}>
                <span>朝向</span>
                {([['down', '向下'], ['up', '向上'], ['both', '双向']] as const).map(([k, label]) => (
                  <button key={k} className={'btn tiny' + (iesAim === k ? ' primary' : '')} onClick={() => setIesAim(k)}>{label}</button>
                ))}
              </div>
            )}
            {isIes && (
              <div className="vp-row"><span>旋转</span>
                <input type="range" min={0} max={360} step={1} value={iesRot} onChange={e => setIesRot(Number(e.target.value))} />
                <NumField value={iesRot} step={1} min={0} max={360} digits={0} width={54} reset={0} onChange={setIesRot} />
              </div>
            )}
            {isIes && iesScene !== 'studio' && (
              <div className="vp-row"><span>灯距墙</span>
                <input type="range" min={0.02} max={1} step={0.01} value={iesDist} onChange={e => setIesDist(Number(e.target.value))} />
                <NumField value={iesDist} step={0.01} min={0} max={5} digits={2} width={54} reset={0.25} onChange={setIesDist} />
              </div>
            )}
            <div className="vp-row"><span>曝光</span>
              <input type="range" min={0.2} max={2.5} step={0.05} value={exposure} onChange={e => setExposure(Number(e.target.value))} />
              <NumField value={exposure} step={0.05} min={0.1} max={4} width={54} reset={1} onChange={setExposure} />
            </div>
            <div className="vp-row"><span>环境</span>
              <input type="range" min={0} max={2} step={0.05} value={envI} onChange={e => setEnvI(Number(e.target.value))} />
              <NumField value={envI} step={0.05} min={0} max={3} width={54} reset={1} onChange={setEnvI} />
            </div>
            {!isIes && (<div className="vp-row"><span>主光</span>
              <input type="range" min={0} max={4} step={0.05} value={keyI} onChange={e => setKeyI(Number(e.target.value))} />
              <NumField value={keyI} step={0.05} min={0} max={8} width={54} reset={1.5} onChange={setKeyI} />
            </div>)}
            {isIes && (
              <div className="vp-row"><span>雾气</span>
                <input type="range" min={0} max={0.2} step={0.002} value={iesFog} onChange={e => setIesFog(Number(e.target.value))} />
                <NumField value={iesFog} step={0.002} min={0} max={1} digits={3} width={54} reset={0.03} onChange={setIesFog} />
              </div>
            )}
            {!isIes && (<div className="vp-lightrow">
              <LightBall az={az} el={el} onChange={(a, e) => { setAz(a); setEl(e); }} />
              <div className="vp-lightnum">
                <div>水平 <b>{az}°</b></div>
                <div>俯仰 <b>{el}°</b></div>
                <div className="hint">拖动球面调整主光方向</div>
              </div>
            </div>)}
          </div>

          {isIes && (<div className="vp-sec">
            <div className="vp-t">射灯</div>
            <div className="vp-row"><span>强度</span>
              <input type="range" min={0} max={4} step={0.05} value={keyI} onChange={e => setKeyI(Number(e.target.value))} />
              <NumField value={keyI} step={0.05} min={0} max={1000000} width={54} reset={1.5} onChange={setKeyI} />
            </div>
            <div className="vp-row"><span>外锥角</span>
              <input type="range" min={1} max={90} step={0.5} value={iesOuter}
                onChange={e => { const v = Math.min(90, Number(e.target.value)); setIesOuter(v); setIesInner(i => Math.min(i, v)); }} />
              <NumField value={iesOuter} step={1} min={0} max={90} digits={0} width={54} reset={30}
                onChange={v => { const x = Math.min(90, Math.max(0, v)); setIesOuter(x); setIesInner(i => Math.min(i, x)); }} />
            </div>
            <div className="vp-row"><span>内锥角</span>
              <input type="range" min={0} max={Math.min(90, iesOuter)} step={0.5} value={iesInner}
                onChange={e => setIesInner(Math.min(iesOuter, Math.max(0, Number(e.target.value))))} />
              <NumField value={iesInner} step={1} min={0} max={90} digits={0} width={54} reset={10}
                onChange={v => setIesInner(Math.min(iesOuter, Math.max(0, v)))} />
            </div>
            <div className="vp-row">
              <label className="vp-check" onClick={() => setUseCct(v => !v)}>
                <span className={'box' + (useCct ? ' on' : '')}>{useCct ? '✓' : ''}</span>使用色温
              </label>
            </div>
            {useCct ? (
              <div className="vp-row"><span>色温 K</span>
                <input type="range" min={2000} max={12000} step={100} value={cct} onChange={e => setCct(Number(e.target.value))} />
                <NumField value={cct} step={100} min={1000} max={40000} digits={0} width={64} reset={6500} onChange={setCct} />
              </div>
            ) : (<>
            <div className="vp-row"><span>色相</span>
              <input type="range" min={0} max={360} step={1} value={iesHue} onChange={e => setIesHue(Number(e.target.value))} />
              <NumField value={iesHue} step={1} min={0} max={360} digits={0} width={54} reset={40} onChange={setIesHue} />
            </div>
            <div className="vp-row"><span>饱和度</span>
              <input type="range" min={0} max={100} step={1} value={Math.round(iesSat * 100)} onChange={e => setIesSat(Number(e.target.value) / 100)} />
              <NumField value={Math.round(iesSat * 100)} step={1} min={0} max={100} digits={0} width={54} reset={12} onChange={v => setIesSat(Math.min(1, Math.max(0, v / 100)))} />
            </div>
            <div className="vp-row"><span>明度</span>
              <input type="range" min={0} max={100} step={1} value={Math.round(iesLight * 100)} onChange={e => setIesLight(Number(e.target.value) / 100)} />
              <NumField value={Math.round(iesLight * 100)} step={1} min={0} max={100} digits={0} width={54} reset={85} onChange={v => setIesLight(Math.min(1, Math.max(0, v / 100)))} />
            </div>
            <div className="vp-row"><span>色块</span>
              <span style={{ width: 46, height: 18, borderRadius: 4, border: '1px solid var(--line)', background: `hsl(${iesHue} ${Math.round(iesSat * 100)}% ${Math.round(iesLight * 100)}%)` }} />
            </div>
            </>)}
          </div>
          )}

          {!isIes && (<div className="vp-sec">
            <div className="vp-t">HDRI 照明</div>
            <select className="field" value={hdriId ?? ''} onChange={e => setHdriId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">不启用（棚拍环境）</option>
              {hdris.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
            <label className="vp-check" onClick={() => setHdriVisible(v => !v)}>
              <span className={'box' + (hdriVisible ? ' on' : '')}>{hdriVisible ? '✓' : ''}</span>显示 HDRI 背景
            </label>
            {hdriId && (<>
              <div className="vp-row"><span>亮度</span>
                <input type="range" min={0} max={3} step={0.05} value={hdriBright} onChange={e => setHdriBright(Number(e.target.value))} />
                <NumField value={hdriBright} step={0.05} min={0} max={5} width={54} reset={1} onChange={setHdriBright} />
              </div>
              <div className="vp-row"><span>旋转</span>
                <input type="range" min={0} max={360} step={1} value={hdriRot} onChange={e => setHdriRot(Number(e.target.value))} />
                <NumField value={hdriRot} step={1} min={0} max={360} digits={0} width={54} reset={0} onChange={setHdriRot} />
              </div>
            </>)}
          </div>)}
          {!isIes && (<div className="vp-sec">
            <div className="vp-t">材质与贴图</div>
            {isModel ? (
              <>
                <div className="vp-sub">材质球</div>
                <button className={'vp-item' + (activeMat === -1 ? ' on' : '')} onClick={() => setActiveMat(-1)}>全部（{matGroups.length}）</button>
                {matGroups.map((m, i) => (
                  <button key={i} className={'vp-item' + (activeMat === i ? ' on' : '')} onClick={() => setActiveMat(i)}>
                    {m.name}<span className="vp-cnt">{m.count}</span>
                  </button>
                ))}
                <button className="btn tiny" style={{ marginTop: 6 }} onClick={() => {
                  setOvMatSel(matGroups[activeMat >= 0 ? activeMat : 0]?.name || matGroups[0]?.name || '');
                  setOvChSel('baseColor');
                  setOvFileSel('');
                  setOvOpen(true);
                }}>贴图覆盖…</button>
              </>
            ) : (
              <>
                <div className="vp-sub">几何体</div>
                <div className="vp-geoms">
                  {(['sphere', 'box', 'cylinder', 'plane'] as GeoKind[]).map(g => (
                    <button key={g} className={'vp-geom' + (geom === g ? ' on' : '')} onClick={() => setGeom(g)}>
                      {{ sphere: '球', box: '方', cylinder: '柱', plane: '面' }[g]}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="vp-sub">贴图</div>
            <div className="vp-row"><span>UV 集</span>
              <select className="sortsel" value={mapUv} onChange={e => setMapUv(Number(e.target.value))}>
                {uvNames.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
            </div>
            {shownTex.map((r: any) => (
              <button className="vp-tex" key={r.k + r.name} onClick={() => setTexPreview({ src: r.src, name: r.name })}>
                <img src={r.src} alt="" loading="lazy" />
                <span>{r.k}</span>
                <em>{r.name}</em>
              </button>
            ))}
            {shownTex.length === 0 && <div className="hint">没有识别到贴图</div>}
          </div>)}
          {!isIes && (<div className="vp-sec">
            <div className="vp-t">显示</div>
            <div className="vp-row"><span>线框</span>
              <button className="btn tiny" onClick={() => setWire(w => (w + 1) % 3)}>
                {wire === 0 ? '关闭' : wire === 1 ? '黑色' : '白色'}
              </button>
            </div>
            <div className="vp-row"><span>视图</span>
              <button className={'btn tiny' + (uvMode ? ' primary' : '')} onClick={() => setUvMode(v => !v)}>UV 分屏</button>
            </div>
          </div>)}
        </aside>
      </div>

      <div className="vxhint">F 聚焦 · 拖动旋转 · 滚轮缩放 · Esc 关闭</div>

      {ovOpen && (
        <div className="modal-mask" onMouseDown={() => setOvOpen(false)}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">贴图覆盖 · {asset.name}</div>
            <div className="hint" style={{ fontSize: 12 }}>
              为某个材质的通道指定贴图，保存后用于预览与发送到 3ds Max（不改 FBX 原文件）。
            </div>
            <div className="uvrow">
              <label>材质</label>
              <select className="sortsel" value={ovMatSel} onChange={e => setOvMatSel(e.target.value)}>
                {matGroups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                {matGroups.length === 0 && <option value="">（未识别到材质）</option>}
              </select>
            </div>
            <div className="uvrow">
              <label>通道</label>
              <select className="sortsel" value={ovChSel} onChange={e => setOvChSel(e.target.value)}>
                {['baseColor', 'normal', 'roughness', 'metallic', 'ao', 'height', 'emissive', 'opacity'].map(c =>
                  <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="uvrow">
              <label>取通道</label>
              <select className="sortsel" value={ovSwz} onChange={e => setOvSwz(e.target.value as any)}>
                <option value="rgb">RGB（彩色原图）</option>
                <option value="r">R 通道（灰度）</option>
                <option value="g">G 通道（灰度）</option>
                <option value="b">B 通道（灰度）</option>
                <option value="a">A 通道（灰度）</option>
              </select>
            </div>
            <div className="uvrow">
              <label>贴图</label>
              <select className="sortsel" style={{ flex: 1 }} value={ovFileSel} onChange={e => setOvFileSel(e.target.value)}>
                <option value="">（清除，恢复自动）</option>
                {asset.files.filter(f => /\.(png|jpe?g|webp|tga|tiff?)$/i.test(f.rel_path)).map(f => (
                  <option key={f.id} value={f.rel_path}>{String(f.rel_path).split('/').pop()}</option>
                ))}
              </select>
            </div>
            <div className="modal-b">
              <button className="btn" onClick={() => setOvOpen(false)}>关闭</button>
              <button className="btn primary" onClick={saveOverride}>保存并重载</button>
            </div>
          </div>
        </div>
      )}

      {texPreview && (
        <div className="texoverlay" onMouseDown={() => setTexPreview(null)}>
          <div className="texbox" onMouseDown={e => e.stopPropagation()}>
            <img src={texPreview.src} alt="" />
            <div className="texname">{texPreview.name}</div>
          </div>
        </div>
      )}
    </div>
  );
}
