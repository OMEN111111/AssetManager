import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { AssetDetail, AssetFile } from './types';
import { CHANNELS, buildMaterial, channelFile, channelHint, channelLabel, detectConfig, missingRequired, type ChannelKey, type MaterialConfig } from './matlib';
import { makeGeometry, remapUV, uprightCylinder, rotateUV90 } from './geometries';
import { history } from './history';
import NumField from './NumField';
import LightBall from './LightBall';

const IMG = /\.(png|jpe?g|webp|tga|tif|tiff)$/i;
const short = (p: string) => p.split(/[\\/]/).pop() || p;

const geoCache = new Map<string, THREE.BufferGeometry | null>();

/** 从 data/geometry/<kind>.(glb|gltf|obj|fbx) 读取用户自定义基本体 */
async function loadCustomGeometry(kind: string): Promise<THREE.BufferGeometry | null> {
  if (geoCache.has(kind)) return geoCache.get(kind)!;
  try {
    const res = await fetch(`/api/geometry/file?kind=${kind}`);
    if (!res.ok) { geoCache.set(kind, null); return null; }
    const ext = (res.headers.get('x-ext') || '').toLowerCase();
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf]));
    let root: any;
    if (ext === '.glb' || ext === '.gltf') {
      const gl: any = await new Promise((ok, no) => new GLTFLoader().load(url, ok, undefined, no));
      root = gl.scene || gl.scenes?.[0];
    } else if (ext === '.obj') {
      root = await new Promise((ok, no) => new OBJLoader().load(url, ok, undefined, no));
    } else {
      root = await new Promise((ok, no) => new FBXLoader().load(url, ok, undefined, no));
    }
    URL.revokeObjectURL(url);
    let mesh: any = root?.isMesh ? root : null;
    root?.traverse?.((o: any) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) { geoCache.set(kind, null); return null; }
    const g = mesh.geometry.clone();
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox.getSize(size);
    const s = 2 / Math.max(size.x, size.y, size.z, 1e-6);
    g.scale(s, s, s);
    g.computeBoundingBox();
    const c = new THREE.Vector3();
    g.boundingBox.getCenter(c);
    g.translate(-c.x, -c.y, -c.z);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) {
      const pos = g.attributes.position;
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = pos.getX(i) / 2 + 0.5;
        uv[i * 2 + 1] = pos.getY(i) / 2 + 0.5;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (!g.attributes.uv1) g.setAttribute('uv1', g.attributes.uv);
    geoCache.set(kind, g);
    return g;
  } catch {
    geoCache.set(kind, null);
    return null;
  }
}

function Slide({ value, onChange, min, max, step = 1, digits = 2, reset, width = 58 }: any) {
  const [lo, setLo] = useState(min);
  const [hi, setHi] = useState(max);
  const handle = (v: number) => {
    if (!Number.isFinite(v)) return;
    if (v < lo) setLo(v);
    if (v > hi) setHi(v);
    onChange(v);
  };
  return (
    <>
      <input className="vslider" type="range" min={lo} max={hi} step={step} value={value}
        onChange={e => handle(Number(e.target.value))} />
      <NumField value={value} step={step} min={-Infinity} max={Infinity} digits={digits}
        width={width} reset={reset} onChange={handle} onReset={() => { setLo(min); setHi(max); }} />
    </>
  );
}

export default function Assembler({ asset, onClose, folderPath }:
  { asset: AssetDetail; onClose: () => void; folderPath?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const api = useRef<any>({});
  const [cfg, setCfg] = useState<MaterialConfig>(() => {
    const normalize = (c: any): MaterialConfig => {
      if (c?.uv && ('u' in c.uv || 'v' in c.uv)) {
        c.uv = {
          repeatU: c.uv.u ?? 1, repeatV: c.uv.v ?? 1,
          rot: c.uv.rot ?? 0, offsetU: 0, offsetV: 0
        };
      }
      return c;
    };
    try { if (asset.material_json) return normalize(JSON.parse(asset.material_json)); } catch { /* ignore */ }
    return detectConfig(asset.files, asset.slotMap);
  });
  const [selected, setSelected] = useState<ChannelKey>('baseColor');
  const [geom, setGeom] = useState<'sphere' | 'box' | 'cylinder' | 'plane'>('sphere');
  const [planeAxis, setPlaneAxis] = useState<'v' | 'h'>('v');
  const [cylAxis, setCylAxis] = useState<'v' | 'h'>('v');
  const [customKinds, setCustomKinds] = useState<Set<string>>(new Set());
  const [exposure, setExposure] = useState(1);
  const [uvLink, setUvLink] = useState(true);
  const [envI, setEnvI] = useState(1);
  const [keyI, setKeyI] = useState(1.3);
  const [az, setAz] = useState(-35);
  const [el, setEl] = useState(25);
  const [hdris, setHdris] = useState<any[]>([]);
  const [hdriId, setHdriId] = useState<number | null>(null);
  const [hdriVisible, setHdriVisible] = useState(false);
  const [hdriRot, setHdriRot] = useState(0);
  const [hdriBright, setHdriBright] = useState(1);
  const [preview, setPreview] = useState<'beauty' | 'albedo' | 'normal' | 'rough' | 'metal' | 'ao' | 'height' | 'emissive' | 'mask'>('beauty');
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const buildSeq = useRef(0);
  const ui = useRef({ exposure, envI, keyI, az, el, hdriId, hdriRot, hdriBright, hdriVisible });
  ui.current = { exposure, envI, keyI, az, el, hdriId, hdriRot, hdriBright, hdriVisible };
  const [saved, setSaved] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<string | null>(null);
  const [mixOpen, setMixOpen] = useState(false);
  const [mixMode, setMixMode] = useState<'ORM' | 'ORMS' | 'custom'>('ORM');
  const [mixFormat, setMixFormat] = useState<'png' | 'jpg'>('png');
  const [mixR, setMixR] = useState<ChannelKey | ''>('ao');
  const [mixG, setMixG] = useState<ChannelKey | ''>('roughness');
  const [mixB, setMixB] = useState<ChannelKey | ''>('metallic');
  const [mixA, setMixA] = useState<ChannelKey | '' | 'smooth'>('');
  const [mixMsg, setMixMsg] = useState('');
  const [mixBusy, setMixBusy] = useState(false);

  const grayChans: { key: ChannelKey; label: string }[] = [
    { key: 'ao', label: 'AO（O）' },
    { key: 'roughness', label: '粗糙度（R）' },
    { key: 'metallic', label: '金属度（M）' },
    { key: 'height', label: '高度（Dp）' },
    { key: 'opacity', label: '不透明（A）' }
  ];

  useEffect(() => {
    if (mixMode === 'ORM') { setMixR('ao'); setMixG('roughness'); setMixB('metallic'); setMixA(''); }
    else if (mixMode === 'ORMS') { setMixR('ao'); setMixG('roughness'); setMixB('metallic'); setMixA('smooth'); }
  }, [mixMode]);

  const urlOf = (f: AssetFile) => /^[a-zA-Z]:[\\/]/.test(f.rel_path)
    ? `/api/path-file?path=${encodeURIComponent(f.rel_path)}`
    : `/api/file/${f.id}`;

  async function lumBuffer(f: AssetFile, W: number, H: number) {
    const bmp = await createImageBitmap(await (await fetch(urlOf(f))).blob());
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d')!;
    c.drawImage(bmp, 0, 0, W, H);
    const d = c.getImageData(0, 0, W, H).data;
    const arr = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      if (Math.abs(d[i] - d[i + 1]) > 12 || Math.abs(d[i] - d[i + 2]) > 12) {
        throw new Error('只支持黑白贴图（颜色贴图不能混合）：' + short(f.rel_path));
      }
      arr[j] = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    }
    return arr;
  }

  async function runMix() {
    if (mixMode === 'custom' && !mixR) { setMixMsg('R 通道必须指定贴图'); return; }
    const smoothFile = asset.files.find(f => /(smooth|gloss)/i.test(f.rel_path) && IMG.test(f.rel_path));
    const pick = (k: ChannelKey | '' | 'smooth') => (k === 'smooth' ? 'roughness' : k);
    const keys = [mixR, mixG, mixB, mixA].map(pick);
    const files = keys.map(k => (k ? channelFile(asset.files, cfg, k as ChannelKey) : null));
    if (!files.some(Boolean)) { setMixMsg('当前材质没有可用于混合的黑白贴图'); return; }
    setMixBusy(true);
    setMixMsg('');
    try {
      const firstFile = files.find(Boolean) as AssetFile;
      const probe = await createImageBitmap(await (await fetch(urlOf(firstFile))).blob());
      const W = probe.width, H = probe.height;
      const bufs = await Promise.all(files.map(f => (f ? lumBuffer(f, W, H) : null)));
      let smooth: Uint8Array | null = null;
      if (mixA === 'smooth') {
        smooth = smoothFile ? await lumBuffer(smoothFile, W, H) : (bufs[3] ? bufs[3].map(v => 255 - v) : null);
        if (!smooth && bufs[3]) smooth = bufs[3].map(v => 255 - v);
      }
      const out = new ImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        const o = i * 4;
        out.data[o] = bufs[0] ? bufs[0][i] : 255;
        out.data[o + 1] = bufs[1] ? bufs[1][i] : 255;
        out.data[o + 2] = bufs[2] ? bufs[2][i] : 255;
        out.data[o + 3] = smooth ? smooth[i] : (bufs[3] ? bufs[3][i] : 255);
      }
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      cv.getContext('2d')!.putImageData(out, 0, 0);
      const dataUrl = mixFormat === 'jpg' ? cv.toDataURL('image/jpeg', 0.92) : cv.toDataURL('image/png');
      let base = short(firstFile.rel_path).replace(/\.[^.]+$/, '');
      base = base.replace(/(?:[_\-\s]?(?:ao|rough(?:ness)?|metal(?:lic)?|height|disp(?:lacement)?|smooth(?:ness)?|opacity|alpha|mask))+$/i, '');
      const sym: Record<string, string> = { ao: 'O', roughness: 'R', metallic: 'M', height: 'Dp', opacity: 'A', smooth: 'S' };
      const tag = mixMode === 'custom'
        ? [mixR, mixG, mixB, mixA].filter(Boolean).map(k => sym[k as string] || '').join('')
        : mixMode;
      const ext = mixFormat === 'jpg' ? 'jpg' : 'png';
      const name = `${base}_${tag || 'mix'}.${ext}`;
      if (asset.id > 0) {
        const r = await fetch('/api/texture/export', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileId: firstFile.id, dataUrl, mode: 'rename', name })
        }).then(x => x.json());
        if (!r.path) throw new Error(r.error || '写入失败');
        await fetch('/api/libraries', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: asset.root })
        });
        setMixMsg('已生成：' + String(r.path).split('\\').pop());
      } else {
        const dir = folderPath || `${asset.root}\\${asset.rel_dir.split('/').join('\\')}`;
        const r = await fetch('/api/path/write-image', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir, name, dataUrl })
        }).then(x => x.json());
        if (!r.path) throw new Error(r.error || '写入失败');
        setMixMsg('已生成：' + String(r.path).split('\\').pop());
      }
    } catch (e: any) {
      setMixMsg('混合失败：' + (e?.message || e));
    } finally {
      setMixBusy(false);
    }
  }
  const lastSaved = useRef<string>(JSON.stringify(cfg));
  const applying = useRef(false);

  const imageFiles = useMemo(() => asset.files.filter(f => IMG.test(f.rel_path)), [asset]);
  const missing = missingRequired(cfg);
  const usedIds = new Set(Object.values(cfg.channels).map(c => c?.fileId).filter(Boolean) as number[]);
  const unused = imageFiles.filter(f => !usedIds.has(f.id));

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const W = el.clientWidth || 800, H = el.clientHeight || 600;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(W, H, true);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0c0e);
    const camera = new THREE.PerspectiveCamera(36, W / H, 0.05, 50);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(-2.5, 4, 3); scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.5); rim.position.set(3, 2, -3); scene.add(rim);

    const geo = makeGeometry('sphere');
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x888888 });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    const ctrl = { yaw: 0.5, pitch: 0.18, dist: 3.5 };
    const apply = () => {
      camera.position.set(
        Math.cos(ctrl.pitch) * Math.sin(ctrl.yaw) * ctrl.dist,
        Math.sin(ctrl.pitch) * ctrl.dist,
        Math.cos(ctrl.pitch) * Math.cos(ctrl.yaw) * ctrl.dist
      );
      camera.lookAt(0, 0, 0);
    };
    apply();

    let raf = 0, drag: any = null;
    const canvas = renderer.domElement;
    const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, b: e.button }; canvas.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.b === 1) { const s = ctrl.dist * 0.0018; ctrl.yaw -= dx * s * 2; ctrl.pitch = Math.max(-1.4, Math.min(1.4, ctrl.pitch + dy * 0.008)); }
      else { ctrl.yaw -= dx * 0.008; ctrl.pitch = Math.max(-1.4, Math.min(1.4, ctrl.pitch + dy * 0.008)); }
      apply();
    };
    const up = () => { drag = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); ctrl.dist = Math.max(1.4, Math.min(12, ctrl.dist * (1 + Math.sign(e.deltaY) * 0.08))); apply(); };
    const keyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'f' || e.key === 'F') { ctrl.yaw = 0.5; ctrl.pitch = 0.18; ctrl.dist = 3.5; apply(); }
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keyDown);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w && h) { renderer.setSize(w, h, true); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    });
    ro.observe(el);

    (window as any).__asmApi = null;
    api.current = { renderer, scene, key, roomEnv: scene.environment, mesh, setGeom: (g: string, axis: 'v' | 'h' = 'v') => {
      const ng = makeGeometry(g as any, axis);
      mesh.geometry.dispose();
      mesh.geometry = ng;
    } };
    (window as any).__asmApi = api.current;

    const loop = () => {
      if (ui.current.hdriId) {
        renderer.toneMappingExposure = 1;
        if (api.current.key) api.current.key.intensity = 0;
        const rot = (ui.current.hdriRot * Math.PI) / 180;
        if (scene.environment) {
          scene.environmentIntensity = ui.current.hdriBright;
          scene.environmentRotation.set(0, rot, 0);
        }
        if ((scene.background as any)?.isTexture) {
          scene.backgroundIntensity = ui.current.hdriBright;
          scene.backgroundRotation.set(0, rot, 0);
        }
      } else {
        renderer.toneMappingExposure = ui.current.exposure;
        const k = api.current.key;
        if (k) {
          k.intensity = ui.current.keyI;
          const a = (ui.current.az * Math.PI) / 180;
          const e = (ui.current.el * Math.PI) / 180;
          k.position.set(Math.cos(e) * Math.sin(a) * 7, Math.sin(e) * 7, Math.cos(e) * Math.cos(a) * 7);
        }
        if (scene.environment) scene.environmentIntensity = ui.current.envI;
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keyDown);
      renderer.dispose();
      el.innerHTML = '';
    };
  }, [asset.id]);

  useEffect(() => { api.current.exposure = exposure; }, [exposure]);

  useEffect(() => {
    (async () => {
      try {
        const st = await fetch('/api/state').then(r => r.json());
        const lib = st.libraries?.[0];
        if (!lib) return;
        const r = await fetch(`/api/assets?lib=${lib.id}&type=hdri&limit=50`).then(x => x.json());
        setHdris(r.assets || []);
      } catch { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const scene = api.current.scene as THREE.Scene | undefined;
    if (!scene) return;
    (async () => {
      if (!hdriId) {
        scene.environment = api.current.roomEnv;
        scene.background = new THREE.Color(0x0b0c0e);
        return;
      }
      try {
        const d = await fetch(`/api/asset/${hdriId}`).then(r => r.json());
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
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [hdriId, hdriVisible]);
  useEffect(() => {
    fetch('/api/geometry/list').then(r => r.json())
      .then(r => setCustomKinds(new Set(((r.files || []) as any[]).map(f => f.kind))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const custom = await loadCustomGeometry(geom);
      if (cancelled) return;
      const ng = custom ? custom.clone() : makeGeometry(geom, planeAxis);
      if (geom === 'cylinder') {
        if (custom) uprightCylinder(ng);
        if (cylAxis === 'h') {
          ng.rotateZ(Math.PI / 2);
          ng.computeBoundingBox();
          const c = new THREE.Vector3();
          ng.boundingBox.getCenter(c);
          ng.translate(-c.x, -c.y, -c.z);
        }
        if (custom) remapUV('cylinder', ng);
      } else if (custom && (geom === 'sphere' || geom === 'box')) {
        remapUV(geom, ng);
      }
      if (custom && geom === 'plane' && planeAxis === 'h') ng.rotateX(-Math.PI / 2);
      const mesh = api.current.mesh;
      if (!mesh) return;
      mesh.geometry.dispose();
      mesh.geometry = ng;
    })();
    return () => { cancelled = true; };
  }, [geom, planeAxis, cylAxis]);
  function triplanar(base: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
    const m = base.clone();
    const prev = base.onBeforeCompile;
    m.onBeforeCompile = (shader: any) => {
      prev?.call(m, shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTriP; varying vec3 vTriN;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vTriP = (modelMatrix * vec4(transformed, 1.0)).xyz;\n vTriN = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTriP; varying vec3 vTriN;')
        .replace('#include <map_fragment>', `
          #ifdef USE_MAP
            vec3 tw = pow(abs(normalize(vTriN)), vec3(4.0));
            tw /= max(tw.x + tw.y + tw.z, 1e-4);
            vec3 tp = vTriP * 0.9;
            diffuseColor *= texture2D(map, tp.zy) * tw.x + texture2D(map, tp.xz) * tw.y + texture2D(map, tp.xy) * tw.z;
          #endif
        `);
    };
    m.customProgramCacheKey = () => 'tri-' + base.uuid;
    return m;
  }

  function previewMaterial(base: THREE.MeshPhysicalMaterial, mode: string): THREE.Material {
    if (mode === 'albedo') return new THREE.MeshBasicMaterial({ map: base.map || null, color: base.map ? 0xffffff : 0x999999 });
    if (mode === 'normal') {
    const m = new THREE.MeshBasicMaterial({ map: base.normalMap || null, color: 0xffffff });
    if (base.normalMap && (base as any).userData?.normalSpace === 'dx') {
      // 法线空间切换时通道预览也要翻转绿色通道
      m.onBeforeCompile = (sh: any) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
          #ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, vMapUv );
            sampledDiffuseColor.g = 1.0 - sampledDiffuseColor.g;
            diffuseColor *= sampledDiffuseColor;
          #endif
        `);
      };
      m.customProgramCacheKey = () => 'normal-dx-flip';
    }
    return m;
  }
    if (mode === 'rough') return new THREE.MeshBasicMaterial({ map: base.roughnessMap || null, color: 0xffffff });
    if (mode === 'metal') return new THREE.MeshBasicMaterial({ map: base.metalnessMap || null, color: 0xffffff });
    if (mode === 'ao') return new THREE.MeshBasicMaterial({ map: base.aoMap || null, color: 0xffffff });
    if (mode === 'height') return new THREE.MeshBasicMaterial({ map: base.displacementMap || null, color: 0xffffff });
    if (mode === 'emissive') return new THREE.MeshBasicMaterial({ map: base.emissiveMap || null, color: 0xffffff });
    if (mode === 'mask') return new THREE.MeshBasicMaterial({ map: base.alphaMap || null, color: 0xffffff });
    return base;
  }

  function applyPreview(base: any) {
    const mesh = api.current.mesh;
    if (!mesh || !base) return;
    mesh.material = previewMaterial(base, previewRef.current);
  }

  useEffect(() => {
    applyPreview(api.current.baseMat);
  }, [preview]);

  useEffect(() => {
    const seq = ++buildSeq.current;
    // 滑动过程中就刷新（每帧一次），而不是等松手后
    const raf = requestAnimationFrame(() => {
      buildMaterial(asset.files, cfg).then(m => {
        if (seq !== buildSeq.current) return; // 丢弃过期构建，避免竞态 dispose 当前材质
        const mesh = api.current.mesh;
        if (!mesh) return;
        const old = mesh.material;
        api.current.baseMat = m;
        mesh.material = previewMaterial(m, previewRef.current);
        if (old && old !== m && old !== mesh.material) old.dispose?.();
        (window as any).__asmMat = m;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [cfg, asset.files]);

  useEffect(() => {
    if (!asset.id) { setSaved(true); return; } // 独立组装（未入库文件夹）不保存
    const json = JSON.stringify(cfg);
    if (json === lastSaved.current) { setSaved(true); return; }
    setSaved(false);
    const t = setTimeout(async () => {
      const prevJson = lastSaved.current;
      await fetch(`/api/asset/${asset.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ material: json })
      });
      lastSaved.current = json;
      setSaved(true);
      if (applying.current) { applying.current = false; return; }
      if (prevJson !== json) {
        const prev = JSON.parse(prevJson) as MaterialConfig;
        const next = JSON.parse(json) as MaterialConfig;
        const apply = (c: MaterialConfig) => {
          applying.current = true;
          setCfg(c);
          lastSaved.current = JSON.stringify(c);
          return fetch(`/api/asset/${asset.id}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ material: JSON.stringify(c) })
          }).then(() => { applying.current = false; });
        };
        history.push({ label: '材质通道调整', undo: () => apply(prev), redo: () => apply(next) });
      }
    }, 900);
    return () => clearTimeout(t);
  }, [cfg]);

  function setChannel(key: ChannelKey, patch: Partial<{ fileId: number; channel: string; intensity: number; invert: boolean; normalSpace: 'gl' | 'dx'; uv: { u: number; v: number; rot: number }; hsl: { h: number; s: number; l: number } }>) {
    setCfg(prev => ({
      ...prev,
      channels: { ...prev.channels, [key]: { ...prev.channels[key], ...patch } }
    }));
  }

  function addChannel(key: ChannelKey) {
    setCfg(prev => ({
      ...prev,
      channels: { ...prev.channels, [key]: { intensity: 0 } }
    }));
    setSelected(key);
  }

  function clearChannel(key: ChannelKey) {
    resetChannel(key);
  }

  function resetChannel(key: ChannelKey) {
    setCfg(prev => {
      const cur = prev.channels[key];
      return {
        ...prev,
        channels: {
          ...prev.channels,
          [key]: cur?.fileId ? { fileId: cur.fileId, channel: cur.channel } : undefined
        }
      };
    });
  }

  async function exportMtlx() {
    if (!window.confirm('将把 .mtlx 写入该素材所在目录，是否继续？')) return;
    setMsg('导出中…');
    if (asset.id > 0) {
      const r = await fetch('/api/mtlx', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id, config: cfg })
      }).then(x => x.json()).catch(e => ({ error: String(e) }));
      setMsg(r.error ? '导出失败：' + r.error : '已导出：' + r.path);
      return;
    }
    // 独立组装：本地生成最小 MaterialX 文档并写入文件夹
    const dir = folderPath || `${asset.root}\\${asset.rel_dir.split('/').join('\\')}`;
    const name = asset.name || 'Material';
    const fileOf = (k: ChannelKey) => {
      const f = channelFile(asset.files, cfg, k);
      return f ? short(f.rel_path) : null;
    };
    const nodes: string[] = [];
    const inputs: string[] = [];
    const add = (id: string, type: string, file: string) => {
      nodes.push(`  <image name="${id}" type="${type}"><input name="file" type="filename" value="${file}"/></image>`);
    };
    const bc = fileOf('baseColor'); if (bc) { add('img_base', 'color3', bc); inputs.push(`    <input name="base_color" type="color3" node="img_base"/>`); }
    const mt = fileOf('metallic'); if (mt) { add('img_metal', 'float', mt); inputs.push(`    <input name="metalness" type="float" node="img_metal"/>`); }
    const rg = fileOf('roughness'); if (rg) { add('img_rough', 'float', rg); inputs.push(`    <input name="specular_roughness" type="float" node="img_rough"/>`); }
    const em = fileOf('emissive'); if (em) { add('img_emit', 'color3', em); inputs.push(`    <input name="emission" type="color3" node="img_emit"/>`); }
    const nr = fileOf('normal');
    if (nr) {
      add('img_normal', 'vector3', nr);
      nodes.push('  <normalmap name="nm_normal" type="vector3"><input name="in" type="vector3" node="img_normal"/></normalmap>');
      inputs.push('    <input name="normal" type="vector3" node="nm_normal"/>');
    }
    const text = `<?xml version="1.0"?>
<materialx version="1.38" colorspace="lin_rec709">
  <standard_surface name="SR_${name}" type="surfaceshader">
${inputs.join('\n')}
  </standard_surface>
${nodes.join('\n')}
  <surfacematerial name="${name}" type="material">
    <input name="surfaceshader" type="surfaceshader" node="SR_${name}"/>
  </surfacematerial>
</materialx>
`;
    const r = await fetch('/api/path/write-text', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, name: `${name}.mtlx`, text })
    }).then(x => x.json()).catch(e => ({ error: String(e) }));
    setMsg(r.error ? '导出失败：' + r.error : '已导出：' + r.path);
  }

  const selFile = channelFile(asset.files, cfg, selected);
  const selCfg = cfg.channels[selected] || {};
  const guv = cfg.uv || { repeatU: 1, repeatV: 1, rot: 0, offsetU: 0, offsetV: 0 };
  const hsl = selCfg.hsl || { h: 0.5, s: 0.5, l: 0.5 };
  const defIntensity = 0;
  const colorChannel = selected === 'baseColor' || selected === 'emissive';

  function setGlobalUv(patch: Partial<{ repeatU: number; repeatV: number; rot: number; offsetU: number; offsetV: number }>) {
    setCfg(prev => ({
      ...prev,
      uv: { ...(prev.uv || { repeatU: 1, repeatV: 1, rot: 0, offsetU: 0, offsetV: 0 }), ...patch }
    }));
  }

  function setHsl(patch: Partial<{ h: number; s: number; l: number }>) {
    setChannel(selected, { hsl: { ...hsl, ...patch } });
  }

  async function bakeSelected(): Promise<{ dataUrl: string; name: string } | null> {
    const ch = cfg.channels[selected];
    const f = ch?.fileId ? asset.files.find(x => x.id === ch.fileId) : undefined;
    if (!f || !ch) return null;
    const bmp = await createImageBitmap(await (await fetch(`/api/file/${f.id}`)).blob());
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const ctx = cv.getContext('2d')!;
    const hsl = ch.hsl;
    if (hsl && (hsl.h || (hsl.s ?? 100) !== 100 || (hsl.l ?? 100) !== 100) && (selected === 'baseColor' || selected === 'emissive')) {
      ctx.filter = `hue-rotate(${((hsl.h ?? 0.5) - 0.5) * 360}deg) saturate(${(hsl.s ?? 0.5) * 2}) brightness(${(hsl.l ?? 0.5) * 2})`;
    }
    ctx.drawImage(bmp, 0, 0);
    ctx.filter = 'none';
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    const k = Math.max(-1, Math.min(1, ch.intensity ?? 0));
    const scalar = ['roughness', 'metallic', 'ao', 'height'].includes(selected);
    const dx = selected === 'normal' && ch.normalSpace === 'dx';
    if (dx || (scalar && k !== 0)) {
      const mag = Math.abs(k);
      const target = k < 0 ? 0 : 255;
      for (let i = 0; i < d.length; i += 4) {
        if (dx) d[i + 1] = 255 - d[i + 1];
        if (scalar && k !== 0) {
          d[i] = Math.round(d[i] * (1 - mag) + target * mag);
          d[i + 1] = Math.round(d[i + 1] * (1 - mag) + target * mag);
          d[i + 2] = Math.round(d[i + 2] * (1 - mag) + target * mag);
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    return { dataUrl: cv.toDataURL('image/png'), name: String(f.rel_path).split('/').pop()! };
  }

  async function exportTextures(mode: 'overwrite' | 'rename') {
    const ch = cfg.channels[selected];
    if (!ch?.fileId) { setExportMsg('当前通道没有贴图'); return; }
    setExporting(true);
    setExportMsg(null);
    setExportPreview(null);
    try {
      const baked = await bakeSelected();
      if (!baked) { setExportMsg('当前通道没有贴图'); return; }
      const r = await fetch('/api/texture/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: ch.fileId, dataUrl: baked.dataUrl, mode })
      }).then(x => x.json());
      if (r.path) {
        setExportPreview(baked.dataUrl);
        setExportMsg(`已导出 ${baked.name} → ${String(r.path).split('\\').pop()}（重扫后可在文件视图看到）`);
      } else {
        setExportMsg('导出失败：' + (r.error || '未知错误'));
      }
    } catch (e: any) {
      setExportMsg('导出失败：' + (e?.message || e));
    } finally {
      setExporting(false);
    }
  }
  const def = CHANNELS.find(c => c.key === selected)!;
  const optionalLeft = CHANNELS.filter(c => c.optional && !cfg.channels[c.key]);

  return (
    <div className="viewer asm">
      <header className="vhead">
        <button className="btn" onClick={onClose}>← 返回</button>
        <div className="vtitle"><b>{asset.name}</b><span>材质组装器</span></div>
        <div className="seg" style={{ marginLeft: 10 }}>
          {(['MR', 'SG'] as const).map(w => (
            <button key={w} className={cfg.workflow === w ? 'on' : ''} onClick={() => setCfg({ ...cfg, workflow: w })}>
              {w === 'MR' ? '金属/粗糙' : '光泽/反射'}
            </button>
          ))}
        </div>
        <div className="vpath" title={folderPath || `${asset.root}\\${asset.rel_dir.split('/').join('\\')}`}>
          {folderPath || `${asset.root}\\${asset.rel_dir.split('/').join('\\')}`}
        </div>
        <div className="vright">
          {missing.length > 0 && <span className="vwarn">缺 {missing.join(' / ')}</span>}
          {asset.id > 0 && <span className="vsave">{saved ? '已保存' : '保存中…'}</span>}
          <button className="btn" onClick={() => { setMixMsg(''); setMixOpen(true); }}>混合贴图</button>
          {asset.id > 0 && <button className="btn" onClick={() => { setExportOpen(true); setExportMsg(null); }}>导出贴图</button>}
          <button className="btn" onClick={exportMtlx}>导出 .mtlx</button>
        </div>
      </header>

      <div className="asm-body">
        <aside className="asm-left">
          <div className="asm-sec">通道</div>
          {CHANNELS.filter(c => !c.optional || cfg.channels[c.key]).map(c => {
            const f = channelFile(asset.files, cfg, c.key);
            return (
              <div key={c.key} className={'chan' + (selected === c.key ? ' on' : '')} onClick={() => setSelected(c.key)}>
                <span className="cdot" data-has={f ? '1' : '0'} />
                <span className="cmeta">
                  <span className="cname">{channelLabel(c.key, cfg.workflow)}</span>
                  <span className="cfile">{f ? short(f.rel_path) : '未连接'}</span>
                </span>
                {cfg.channels[c.key]?.channel && c.scalar && cfg.channels[c.key]!.channel !== 'rgb' && (
                  <span className="ckey">{cfg.channels[c.key]!.channel!.toUpperCase()}</span>
                )}
              </div>
            );
          })}
          {optionalLeft.map(o => (
            <div key={o.key} className="chan add" onClick={() => addChannel(o.key)}>
              <span className="cdot" data-has="0" />
              <span className="cmeta">
                <span className="cname">+ {o.label}</span>
                <span className="cfile">{o.hint}</span>
              </span>
            </div>
          ))}

          <div className="asm-sec">未使用贴图 · {unused.length}</div>
          <div className="unused">
            {unused.map(f => (
              <button key={f.id} className="uth" title={short(f.rel_path)}
                onClick={() => setChannel(selected, { fileId: f.id, channel: def.scalar ? def.defChannel : 'rgb', intensity: 0 })}>
                {short(f.rel_path).slice(0, 14)}
              </button>
            ))}
            {unused.length === 0 && <div className="uhint">全部贴图已用</div>}
          </div>
        </aside>

        <div className="asm-stage">
          <div className="vmount" ref={mount} />
          <div className="asm-rail">
            {([
              ['beauty', '材质', true],
              ['albedo', '颜色', !!cfg.channels.baseColor?.fileId],
              ['normal', '法线', !!cfg.channels.normal?.fileId],
              ['rough', '粗糙度', !!cfg.channels.roughness?.fileId],
              ['metal', '金属度', !!cfg.channels.metallic?.fileId],
              ['ao', 'AO', !!cfg.channels.ao?.fileId],
              ['height', '高度', !!cfg.channels.height?.fileId],
              ['emissive', '自发光', !!cfg.channels.emissive?.fileId],
              ['mask', '遮罩', !!cfg.channels.opacity?.fileId]
            ] as const).filter(x => x[2]).map(([k, label]) => (
              <button key={k} title={label} className={'ci ci-' + k + (preview === k ? ' on' : '')}
                onClick={() => setPreview(k)} />
            ))}
            <div className="rail-sep" />
            {(['sphere', 'box', 'cylinder', 'plane'] as const).map(g => (
              <button key={g}
                title={(g === 'plane'
                  ? (planeAxis === 'v' ? '平面（竖直）· 再次点击切换水平' : '平面（水平）· 再次点击切换竖直')
                  : g === 'cylinder'
                    ? (cylAxis === 'v' ? '柱（立）· 再次点击切换倒' : '柱（倒）· 再次点击切换立')
                    : { sphere: '球', box: '圆角方', cylinder: '柱', plane: '平面' }[g]) + (customKinds.has(g) ? '（自定义）' : '')}
                className={'ci gi-' + g + (geom === g ? ' on' : '')}
                onClick={() => {
                  if (g === 'plane' && geom === 'plane') setPlaneAxis(a => (a === 'v' ? 'h' : 'v'));
                  else if (g === 'cylinder' && geom === 'cylinder') setCylAxis(a => (a === 'v' ? 'h' : 'v'));
                  else setGeom(g);
                }} />
            ))}
          </div>
          <div className="vxhint">F 聚焦 · 拖动旋转 · 滚轮缩放 · Esc 关闭</div>
        </div>

        <aside className="asm-right">
          <div className={'vp-sec' + (hdriId ? ' off' : '')}>
            <div className="vp-t">光照 {hdriId ? '（HDRI 接管）' : ''}</div>
            <div className="vp-row"><span>曝光</span>
              <Slide value={exposure} onChange={setExposure} min={0.2} max={2.5} step={0.05} reset={1} width={54} />
            </div>
            <div className="vp-row"><span>环境</span>
              <Slide value={envI} onChange={setEnvI} min={0} max={2} step={0.05} reset={1} width={54} />
            </div>
            <div className="vp-row"><span>主光</span>
              <Slide value={keyI} onChange={setKeyI} min={0} max={4} step={0.05} reset={1.3} width={54} />
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

          <div className="vp-sec">
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
                <Slide value={hdriBright} onChange={setHdriBright} min={0} max={3} step={0.05} reset={1} width={54} />
              </div>
              <div className="vp-row"><span>旋转</span>
                <Slide value={hdriRot} onChange={setHdriRot} min={0} max={360} step={1} digits={0} reset={0} width={54} />
              </div>
            </>)}
          </div>

          <div className="param">
            <div className="plabel">整体 UV<span>平铺 / 旋转 / 位移 · 全部通道</span></div>
            <div className="uvrow">
              <label>平铺 U</label>
              <Slide value={guv.repeatU} step={0.05} min={0.1} max={8} reset={1} width={58}
                onChange={v => setGlobalUv(uvLink ? { repeatU: v, repeatV: v } : { repeatU: v })} />
            </div>
            <div className="uvrow" style={{ justifyContent: 'center', padding: '2px 0' }}>
              <button className={'linkbtn' + (uvLink ? ' on' : '')}
                title={uvLink ? '已联动：调整 U 时 V 同步' : '未联动：U / V 独立'}
                onClick={() => {
                  const next = !uvLink;
                  setUvLink(next);
                  if (next) setGlobalUv({ repeatU: guv.repeatU, repeatV: guv.repeatU });
                }}>📎</button>
            </div>
            <div className="uvrow">
              <label>平铺 V</label>
              <Slide value={guv.repeatV} step={0.05} min={0.1} max={8} reset={1} width={58}
                onChange={v => setGlobalUv(uvLink ? { repeatU: v, repeatV: v } : { repeatV: v })} />
            </div>
            <div className="uvrow">
              <label>旋转</label>
              <Slide value={Math.round((guv.rot * 180) / Math.PI)} min={-180} max={180} step={1}
                digits={0} reset={0} width={58} onChange={v => setGlobalUv({ rot: (v * Math.PI) / 180 })} />
            </div>
            <div className="uvrow">
              <label>位移 U</label>
              <Slide value={guv.offsetU} min={-1} max={1} step={0.01} reset={0} width={58}
                onChange={v => setGlobalUv({ offsetU: v })} />
            </div>
            <div className="uvrow">
              <label>位移 V</label>
              <Slide value={guv.offsetV} min={-1} max={1} step={0.01} reset={0} width={58}
                onChange={v => setGlobalUv({ offsetV: v })} />
            </div>
          </div>

          <div className="param">
            <div className="plabel">{channelLabel(selected, cfg.workflow)}<span>{channelHint(selected, cfg.workflow)}</span></div>
          </div>
          <div className="param">
            <div className="plabel">来源</div>
            <select className="field" value={selCfg.fileId ?? ''} onChange={e => setChannel(selected, { fileId: Number(e.target.value) || undefined })}>
              <option value="">未连接</option>
              {imageFiles.map(f => <option key={f.id} value={f.id}>{short(f.rel_path)}</option>)}
            </select>
          </div>
          {def.scalar && (
            <div className="param">
              <div className="plabel">取通道</div>
              <div className="seg" style={{ width: '100%' }}>
                {(['rgb', 'r', 'g', 'b'] as const).map(ch => (
                  <button key={ch} style={{ flex: 1 }} className={(selCfg.channel || def.defChannel) === ch ? 'on' : ''}
                    onClick={() => setChannel(selected, { channel: ch })}>{ch.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}
          {selected === 'normal' && (
            <div className="param">
              <div className="plabel">法线空间<span>DX 需翻转 G 通道</span></div>
              <div className="seg" style={{ width: '100%' }}>
                {(['gl', 'dx'] as const).map(ns => (
                  <button key={ns} style={{ flex: 1 }} className={(selCfg.normalSpace || 'gl') === ns ? 'on' : ''}
                    onClick={() => setChannel('normal', { normalSpace: ns })}>{ns.toUpperCase()}</button>
                ))}
              </div>
            </div>
          )}
          {!colorChannel && (
            <div className="param">
              <div className="plabel">强度</div>
              <div className="uvrow">
                <Slide key={selected} value={selCfg.intensity ?? 1} step={0.01} min={-1} max={1}
                  reset={1} width={66} onChange={v => setChannel(selected, { intensity: v })} />
              </div>
            </div>
          )}

          {(selected === 'baseColor' || selected === 'emissive') && (
            <div className="param">
              <div className="plabel">HSL<span>色相 / 饱和度 / 明度</span></div>
              {([['h', 'H', 0, 1], ['s', 'S', 0, 1], ['l', 'L', 0, 1]] as const).map(([k, label, lo, hi]) => (
                <div className="uvrow" key={k}>
                  <label>{label}</label>
                  <Slide key={selected + k} value={(hsl as any)[k]} step={0.01} min={lo} max={hi}
                    digits={2} reset={0.5} width={52} onChange={v => setHsl({ [k]: v } as any)} />
                </div>
              ))}
            </div>
          )}

          <div className="param">
            <div className="plabel">恢复默认<span>保留贴图，清空强度/法线方向/HSL</span></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => resetChannel(selected)}>恢复默认</button>
            </div>
          </div>
          <div className="param note">
            <div className="plabel">工作流</div>
            <div className="hint">
              {cfg.workflow === 'MR'
                ? 'Metallic / Roughness：贴图按 G=粗糙、B=金属读取。'
                : 'Specular / Glossiness：按 Gloss = 1 - Rough 近似换算，非物理等价。'}
            </div>
          </div>
          {msg && <div className="param note"><div className="hint">{msg}</div></div>}
        </aside>
      </div>


      {mixOpen && (
        <div className="modal-mask" onMouseDown={() => { if (!mixBusy) setMixOpen(false); }}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">混合贴图（黑白通道）</div>
            <div className="uvrow">
              <label>方式</label>
              <select className="sortsel" value={mixMode} onChange={e => setMixMode(e.target.value as any)}>
                <option value="ORM">ORM（R=AO，G=粗糙度，B=金属度）</option>
                <option value="ORMS">ORMS（R=AO，G=粗糙度，B=金属度，A=平滑度）</option>
                <option value="custom">自定义 RGBA</option>
              </select>
            </div>
            <div className="uvrow">
              <label>R</label>
              <select className="sortsel" value={mixR as string} disabled={mixMode !== 'custom'}
                onChange={e => setMixR(e.target.value as any)}>
                {grayChans.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
            <div className="uvrow">
              <label>G</label>
              <select className="sortsel" value={mixG as string} disabled={mixMode !== 'custom' || !mixR}
                onChange={e => { const v = e.target.value as any; setMixG(v); if (!v) { setMixB(''); setMixA(''); } }}>
                <option value="">空（255）</option>
                {grayChans.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
            <div className="uvrow">
              <label>B</label>
              <select className="sortsel" value={mixB as string} disabled={mixMode !== 'custom' || !mixG}
                onChange={e => { const v = e.target.value as any; setMixB(v); if (!v) setMixA(''); }}>
                <option value="">空（255）</option>
                {grayChans.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </div>
            <div className="uvrow">
              <label>A</label>
              <select className="sortsel" value={mixA as string} disabled={mixMode !== 'custom' || !mixB}
                onChange={e => setMixA(e.target.value as any)}>
                <option value="">空（255）</option>
                {grayChans.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                <option value="smooth">平滑度（优先平滑度贴图，否则 1-粗糙度）</option>
              </select>
            </div>
            <div className="uvrow">
              <label>格式</label>
              <select className="sortsel" value={mixFormat} onChange={e => setMixFormat(e.target.value as any)}>
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
              </select>
            </div>
            <div className="hint" style={{ fontSize: 12 }}>
              通道必须按 RGBA 连续设置：R 必填；前面的通道留空后，后面的通道自动清空且不可再选。
              仅支持黑白贴图；输出后缀按通道类型命名（O=AO、R=粗糙、M=金属、Dp=高度、A=不透明）。
            </div>
            {mixMsg && <div className="hint" style={{ color: 'var(--accent)' }}>{mixMsg}</div>}
            <div className="modal-b">
              <button className="btn" disabled={mixBusy} onClick={() => setMixOpen(false)}>关闭</button>
              <button className="btn primary" disabled={mixBusy} onClick={runMix}>{mixBusy ? '生成中…' : '生成混合贴图'}</button>
            </div>
          </div>
        </div>
      )}

      {exportOpen && (
        <div className="modal-mask" onMouseDown={() => { if (!exporting) setExportOpen(false); }}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">导出处理后的贴图</div>
            <div className="hint" style={{ fontSize: 12 }}>
              导出当前选中通道（{CHANNELS.find(c => c.key === selected)?.label}）经过强度 / 法线方向 / HSL 处理后的 PNG。
              覆盖仅对 PNG 原图生效，其余格式会另存为 *_edited.png。
            </div>
            <div className="uvrow" style={{ gap: 8 }}>
              <button className="btn" disabled={exporting} onClick={() => exportTextures('overwrite')}>覆盖原图</button>
              <button className="btn primary" disabled={exporting} onClick={() => exportTextures('rename')}>另存副本</button>
            </div>
            {exporting && <div className="hint">处理中…</div>}
            {exportPreview && (
              <div style={{ marginTop: 8, textAlign: 'center' }}>
                <img src={exportPreview} alt="" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 6, border: '1px solid var(--border)' }} />
              </div>
            )}
            {exportMsg && <div className="hint" style={{ color: 'var(--accent)' }}>{exportMsg}</div>}
            <div className="modal-b">
              <button className="btn" onClick={() => setExportOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}







