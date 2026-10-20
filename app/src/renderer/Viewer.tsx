import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { IESLoader } from 'three/examples/jsm/loaders/IESLoader.js';
import NumField from './NumField';
import { detectConfig } from './matlib';
import { makeGeometry } from './geometries';
import type { AssetDetail, AssetFile } from './types';

type Preset = 'maya' | 'max' | 'blender';
type Channel = 'beauty' | 'albedo' | 'clay' | 'normal' | 'rough' | 'metallic' | 'ao' | 'emissive' | 'checker';
type GeoKind = 'sphere' | 'box' | 'cylinder' | 'plane';

const lc = (f: AssetFile) => f.rel_path.toLowerCase();
const apiJson = (p: string) => fetch(p).then(r => r.json());

function findFile(files: AssetFile[], ...keys: string[]) {
  for (const k of keys) {
    const hit = files.find(f => lc(f).includes(k));
    if (hit) return hit;
  }
  return undefined;
}

const CHANNEL_META: { key: Channel; label: string }[] = [
  { key: 'beauty', label: '材质' },
  { key: 'albedo', label: '颜色' },
  { key: 'clay', label: '白膜' },
  { key: 'normal', label: '法线' },
  { key: 'rough', label: '粗糙度' },
  { key: 'metallic', label: '金属度' },
  { key: 'ao', label: 'AO' },
  { key: 'emissive', label: '自发光' },
  { key: 'checker', label: 'UV 棋盘' }
];

let checkerTex: THREE.Texture | null = null;
function makeChecker() {
  if (checkerTex) return checkerTex;
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d')!;
  const n = 8, s = 1024 / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    g.fillStyle = (x + y) % 2 ? '#202020' : '#e6e6e6';
    g.fillRect(x * s, y * s, s, s);
  }
  g.strokeStyle = '#ff3b6b';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 1021, 1021);
  checkerTex = new THREE.CanvasTexture(c);
  checkerTex.wrapS = checkerTex.wrapT = THREE.RepeatWrapping;
  checkerTex.colorSpace = THREE.SRGBColorSpace;
  checkerTex.anisotropy = 8;
  return checkerTex;
}

function channelMaterial(mode: Channel, base: THREE.MeshPhysicalMaterial): THREE.Material {
  if (mode === 'albedo') {
    return new THREE.MeshBasicMaterial({
      map: base.map || null,
      color: base.map ? 0xffffff : (base.color?.clone?.() || new THREE.Color(0xcccccc))
    });
  }
  if (mode === 'clay') return new THREE.MeshStandardMaterial({ color: 0xdadada, roughness: 0.55, metalness: 0 });
  if (mode === 'checker') return new THREE.MeshStandardMaterial({ map: makeChecker(), roughness: 0.6, metalness: 0 });
  if (mode === 'normal') return new THREE.MeshNormalMaterial();
  if (mode === 'emissive') {
    return new THREE.MeshBasicMaterial({ map: base.emissiveMap || null, color: 0xffffff });
  }
  const map = mode === 'rough' ? base.roughnessMap : mode === 'metallic' ? base.metalnessMap : base.aoMap;
  const comp = mode === 'rough' ? 1 : mode === 'metallic' ? 2 : 0;
  if (!map) return new THREE.MeshStandardMaterial({ color: 0x6f747c, roughness: 1, metalness: 0 });
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, comp: { value: comp } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform int comp; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(map, vUv);
        float v = comp == 0 ? c.r : (comp == 1 ? c.g : c.b);
        gl_FragColor = vec4(vec3(v), 1.0);
      }`
  });
}

function LightBall({ az, el, onChange }: { az: number; el: number; onChange: (a: number, e: number) => void }) {
  const drag = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const update = (e: any) => {
    const b = ref.current!.getBoundingClientRect();
    let x = ((e.clientX - b.left) / b.width) * 2 - 1;
    let y = ((e.clientY - b.top) / b.height) * 2 - 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    onChange(Math.round(x * 90), Math.round(-y * 90));
  };
  return (
    <div className="lightball" ref={ref}
      onPointerDown={e => { drag.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); update(e); }}
      onPointerMove={e => { if (drag.current) update(e); }}
      onPointerUp={() => { drag.current = false; }}>
      <span className="lb-dot" style={{ left: `${50 + az / 1.8}%`, top: `${50 + el / 1.8}%` }} />
    </div>
  );
}

export default function Viewer({ asset, onClose, variants, onVariant }:
  { asset: AssetDetail; onClose: () => void; variants?: any[]; onVariant?: (id: number) => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const uvCanvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<any>({});

  const [channel, setChannel] = useState<Channel>('beauty');
  const [wire, setWire] = useState(0); // 0 关 / 1 黑 / 2 白
  const [uvMode, setUvMode] = useState(false);
  const [split, setSplit] = useState(50);
  const [uvSet, setUvSet] = useState('uv');
  const [udim, setUdim] = useState('all');
  const [activeMat, setActiveMat] = useState(-1);
  const [meshList, setMeshList] = useState<any[]>([]);
  const [matGroups, setMatGroups] = useState<{ name: string; count: number }[]>([]);
  const [tiles, setTiles] = useState<string[]>([]);

  const [exposure, setExposure] = useState(1);
  const [envI, setEnvI] = useState(1);
  const [keyI, setKeyI] = useState(1.5);
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
      if (api.current.iesSpot) {
        renderer.toneMappingExposure = ui.current.exposure;
        api.current.iesSpot.intensity = ui.current.keyI * 200;
        api.current.iesAmbient.intensity = ui.current.envI * 0.1;
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
      const tex = (f: AssetFile, srgb = false) => new Promise<THREE.Texture>((res, rej) => {
        new THREE.TextureLoader().load(`/api/file/${f.id}`, t => {
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 8;
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
          res(t);
        }, undefined, rej);
      });

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
        const iesFile = findFile(files, '.ies');
        if (!iesFile) { setError('没有 .ies 文件'); setStatus(''); return; }
        setStatus('解析 IES…');
        const iesTex = await new IESLoader().loadAsync(`/api/file/${iesFile.id}`);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(7, 7),
          new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.85, metalness: 0 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        scene.add(ground);
        scene.environment = null;
        const ambient = new THREE.AmbientLight(0xffffff, 0.06);
        scene.add(ambient);
        const spot = new THREE.SpotLight(0xffffff, 200, 0, Math.PI / 8, 0.5, 2);
        spot.position.set(0, 3.4, 0);
        spot.target.position.set(0, 0, 0);
        spot.map = iesTex;
        spot.castShadow = true;
        spot.shadow.mapSize.set(1024, 1024);
        scene.add(spot);
        scene.add(spot.target);
        api.current.iesSpot = spot;
        api.current.iesAmbient = ambient;
        api.current.meshes = [{ mesh: ground, matName: '地面' }];
        setMatGroups([{ name: '地面', count: 1 }]);
        camera.position.set(3.4, 2.6, 4.6);
        camera.lookAt(0, 0.4, 0);
        ctrl.target.set(0, 0.3, 0);
        ctrl.dist = 5.4;
        setStatus('');
        return;
      }

      if (isModel) {
        const modelFile = findFile(files, '.fbx');
        if (!modelFile) { setError('当前仅支持 FBX 模型预览'); setStatus(''); return; }
        setStatus('解析模型…');
        const obj = await new Promise<THREE.Group>((res, rej) => new FBXLoader().load(`/api/file/${modelFile.id}`, res, undefined, rej));
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
  }, [asset.id]);

  // channel material
  useEffect(() => {
    const m = api.current.baseMat;
    if (!m || !api.current.setMaterial) return;
    if (channel === 'beauty') api.current.restoreMaterials?.();
    else api.current.setMaterial(channelMaterial(channel, m));
  }, [channel, asset.id, meshList.length]);

  // geometry
  useEffect(() => { api.current.setGeom?.(geom); }, [geom, asset.id]);

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

  const cfg = useMemo(() => detectConfig(asset.files), [asset.files]);
  const textureRows = Object.entries(cfg.channels)
    .map(([k, v]: any) => {
      const f = asset.files.find(x => x.id === v?.fileId);
      return f ? { k, id: f.id, src: `/api/file/${f.id}`, name: String(f.rel_path).split('/').pop() } : null;
    })
    .filter(Boolean) as { k: string; id: number; src: string; name: string }[];
  const shownTex = activeMat >= 0 && groupTex[activeMat] ? groupTex[activeMat] : textureRows;

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
            <div className="vp-t">光照 {hdriId ? '（HDRI 接管）' : isIes ? '（IES 射灯）' : ''}</div>
            <div className="vp-row"><span>曝光</span>
              <input type="range" min={0.2} max={2.5} step={0.05} value={exposure} onChange={e => setExposure(Number(e.target.value))} />
              <NumField value={exposure} step={0.05} min={0.1} max={4} width={54} reset={1} onChange={setExposure} />
            </div>
            <div className="vp-row"><span>环境</span>
              <input type="range" min={0} max={2} step={0.05} value={envI} onChange={e => setEnvI(Number(e.target.value))} />
              <NumField value={envI} step={0.05} min={0} max={3} width={54} reset={1} onChange={setEnvI} />
            </div>
            <div className="vp-row"><span>{isIes ? '强度' : '主光'}</span>
              <input type="range" min={0} max={4} step={0.05} value={keyI} onChange={e => setKeyI(Number(e.target.value))} />
              <NumField value={keyI} step={0.05} min={0} max={8} width={54} reset={1.5} onChange={setKeyI} />
            </div>
            <div className="vp-lightrow">
              <LightBall az={az} el={el} onChange={(a, e) => { setAz(a); setEl(e); }} />
              <div className="vp-lightnum">
                <div>水平 <b>{az}°</b></div>
                <div>俯仰 <b>{el}°</b></div>
                <div className="hint">拖动球面调整主光方向</div>
              </div>
            </div>
          </div>

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
          <div className="vp-sec">
            <div className="vp-t">显示</div>
            <div className="vp-row"><span>线框</span>
              <button className="btn tiny" onClick={() => setWire(w => (w + 1) % 3)}>
                {wire === 0 ? '关闭' : wire === 1 ? '黑色' : '白色'}
              </button>
            </div>
            <div className="vp-row"><span>视图</span>
              <button className={'btn tiny' + (uvMode ? ' primary' : '')} onClick={() => setUvMode(v => !v)}>UV 分屏</button>
            </div>
          </div>
        </aside>
      </div>

      <div className="vxhint">F 聚焦 · 拖动旋转 · 滚轮缩放 · Esc 关闭</div>

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
