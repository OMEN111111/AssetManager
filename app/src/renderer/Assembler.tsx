import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import type { AssetDetail, AssetFile } from './types';
import { CHANNELS, buildMaterial, channelFile, channelHint, channelLabel, detectConfig, missingRequired, type ChannelKey, type MaterialConfig } from './matlib';
import { makeGeometry } from './geometries';
import { history } from './history';
import NumField from './NumField';
import LightBall from './LightBall';

const IMG = /\.(png|jpe?g|webp|tga|tif|tiff)$/i;
const short = (p: string) => p.split('/').pop() || p;

export default function Assembler({ asset, onClose, variants, onVariant }:
  { asset: AssetDetail; onClose: () => void; variants?: any[]; onVariant?: (id: number) => void }) {
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
    return detectConfig(asset.files);
  });
  const [selected, setSelected] = useState<ChannelKey>('baseColor');
  const [geom, setGeom] = useState<'sphere' | 'box' | 'cylinder' | 'plane'>('sphere');
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
  const [downOpen, setDownOpen] = useState(false);
  const [downTarget, setDownTarget] = useState(2048);
  const [downMode, setDownMode] = useState<'overwrite' | 'rename'>('rename');
  const [downInfo, setDownInfo] = useState<{ w: number; h: number; fileId: number; name: string } | null>(null);
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
    api.current = { renderer, scene, key, roomEnv: scene.environment, mesh, setGeom: (g: string) => {
      const ng = makeGeometry(g as any);
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
  useEffect(() => { api.current.setGeom?.(geom); }, [geom]);
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
    if (mode === 'normal') return new THREE.MeshBasicMaterial({ map: base.normalMap || null, color: 0xffffff });
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
    const t = setTimeout(() => {
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
    }, 120);
    return () => clearTimeout(t);
  }, [cfg, asset.files]);

  useEffect(() => {
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
    const r = await fetch('/api/mtlx', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetId: asset.id, config: cfg })
    }).then(x => x.json()).catch(e => ({ error: String(e) }));
    setMsg(r.error ? '导出失败：' + r.error : '已导出：' + r.path);
  }

  const selFile = channelFile(asset.files, cfg, selected);
  const selCfg = cfg.channels[selected] || {};
  const guv = cfg.uv || { repeatU: 1, repeatV: 1, rot: 0, offsetU: 0, offsetV: 0 };
  const hsl = selCfg.hsl || { h: 0, s: 0, l: 0 };
  const defIntensity = selected === 'height' ? 0.04 : 1;
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
    if (hsl && (hsl.h || hsl.s || hsl.l) && (selected === 'baseColor' || selected === 'emissive')) {
      ctx.filter = `hue-rotate(${hsl.h}deg) saturate(${1 + hsl.s / 100}) brightness(${1 + hsl.l / 100})`;
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
  async function openDowngrade() {
    const ch = cfg.channels[selected];
    const f = ch?.fileId ? asset.files.find(x => x.id === ch.fileId) : undefined;
    if (!f) { setExportMsg('当前通道没有贴图'); return; }
    const bmp = await createImageBitmap(await (await fetch(`/api/file/${f.id}`)).blob());
    const maxDim = Math.max(bmp.width, bmp.height);
    const opts = [4096, 2048, 1024, 512].filter(v => v < maxDim);
    if (!opts.length) { setExportMsg('当前贴图已经是最低分辨率，无法继续降级'); return; }
    setDownInfo({ w: bmp.width, h: bmp.height, fileId: f.id, name: String(f.rel_path).split('/').pop()! });
    setDownTarget(opts[0]);
    setDownMode('rename');
    setDownOpen(true);
  }

  async function runDowngrade() {
    if (!downInfo) return;
    setExporting(true);
    try {
      const bmp = await createImageBitmap(await (await fetch(`/api/file/${downInfo.fileId}`)).blob());
      const maxDim = Math.max(bmp.width, bmp.height);
      const scale = downTarget / maxDim;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * scale));
      cv.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL('image/png');
      let name = downInfo.name.replace(/\.(png|jpe?g|tga|tiff?|bmp)$/i, '.png');
      const tok = /(\d+)k(?=[^a-z0-9]|$)/i;
      name = tok.test(name) ? name.replace(tok, `${downTarget / 1024}k`) : name.replace(/\.png$/i, `_${downTarget / 1024}k.png`);
      const r = await fetch('/api/texture/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileId: downInfo.fileId, dataUrl, mode: downMode, name })
      }).then(x => x.json());
      setDownOpen(false);
      setExportMsg(r.path ? `已生成 ${String(r.path).split('\\').pop()}（${downTarget}px）` : '降级失败：' + (r.error || ''));
    } catch (e: any) {
      setExportMsg('降级失败：' + (e?.message || e));
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
        <div className="vright">
          {variants && variants.length > 1 && (
            <div className="seg" style={{ marginRight: 8 }}>
              {variants.filter(v => v.res || v.lod != null).map(v => (
                <button key={v.id} className={v.id === asset.id ? 'on' : ''} onClick={() => onVariant?.(v.id)}>
                  {v.lod != null ? `LOD${v.lod}` : `${v.res}K`}
                </button>
              ))}
            </div>
          )}
          {missing.length > 0 && <span className="vwarn">缺 {missing.join(' / ')}</span>}
          <span className="vsave">{saved ? '已保存' : '保存中…'}</span>
          <button className="btn" onClick={() => { setExportOpen(true); setExportMsg(null); }}>导出贴图</button>
          <button className="btn" onClick={openDowngrade}>降级贴图</button>
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
              <button key={g} title={{ sphere: '球', box: '圆角方', cylinder: '柱', plane: '平面' }[g]}
                className={'ci gi-' + g + (geom === g ? ' on' : '')} onClick={() => setGeom(g)} />
            ))}
          </div>
          <div className="vxhint">F 聚焦 · 拖动旋转 · 滚轮缩放 · Esc 关闭</div>
        </div>

        <aside className="asm-right">
          <div className={'vp-sec' + (hdriId ? ' off' : '')}>
            <div className="vp-t">光照 {hdriId ? '（HDRI 接管）' : ''}</div>
            <div className="vp-row"><span>曝光</span>
              <input type="range" min={0.2} max={2.5} step={0.05} value={exposure} onChange={e => setExposure(Number(e.target.value))} />
              <NumField value={exposure} step={0.05} min={0.1} max={4} width={54} reset={1} onChange={setExposure} />
            </div>
            <div className="vp-row"><span>环境</span>
              <input type="range" min={0} max={2} step={0.05} value={envI} onChange={e => setEnvI(Number(e.target.value))} />
              <NumField value={envI} step={0.05} min={0} max={3} width={54} reset={1} onChange={setEnvI} />
            </div>
            <div className="vp-row"><span>主光</span>
              <input type="range" min={0} max={4} step={0.05} value={keyI} onChange={e => setKeyI(Number(e.target.value))} />
              <NumField value={keyI} step={0.05} min={0} max={8} width={54} reset={1.3} onChange={setKeyI} />
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
                <input type="range" min={0} max={3} step={0.05} value={hdriBright} onChange={e => setHdriBright(Number(e.target.value))} />
                <NumField value={hdriBright} step={0.05} min={0} max={5} width={54} reset={1} onChange={setHdriBright} />
              </div>
              <div className="vp-row"><span>旋转</span>
                <input type="range" min={0} max={360} step={1} value={hdriRot} onChange={e => setHdriRot(Number(e.target.value))} />
                <NumField value={hdriRot} step={1} min={0} max={360} digits={0} width={54} reset={0} onChange={setHdriRot} />
              </div>
            </>)}
          </div>

          <div className="param">
            <div className="plabel">整体 UV<span>平铺 / 旋转 / 位移 · 全部通道</span></div>
            <div className="uvrow">
              <label>平铺 U</label>
              <input className="vslider" type="range" min={0.1} max={8} step={0.05} value={guv.repeatU}
                onChange={e => {
                  const v = Number(e.target.value);
                  setGlobalUv(uvLink ? { repeatU: v, repeatV: v } : { repeatU: v });
                }} />
              <NumField value={guv.repeatU} step={0.05} min={0.01} max={50} width={58} reset={1}
                onChange={v => setGlobalUv(uvLink ? { repeatU: v, repeatV: v } : { repeatU: v })} />
            </div>
            <div className="uvrow">
              <label>平铺 V</label>
              <input className="vslider" type="range" min={0.1} max={8} step={0.05} value={guv.repeatV}
                onChange={e => {
                  const v = Number(e.target.value);
                  setGlobalUv(uvLink ? { repeatU: v, repeatV: v } : { repeatV: v });
                }} />
              <NumField value={guv.repeatV} step={0.05} min={0.01} max={50} width={58} reset={1}
                onChange={v => setGlobalUv(uvLink ? { repeatU: v, repeatV: v } : { repeatV: v })} />
            </div>
            <div className="uvrow">
              <label>联动</label>
              <button className={'btn tiny' + (uvLink ? ' primary' : '')}
                onClick={() => {
                  const next = !uvLink;
                  setUvLink(next);
                  if (next) setGlobalUv({ repeatU: guv.repeatU, repeatV: guv.repeatU });
                }}>
                {uvLink ? 'U = V' : 'U / V 独立'}
              </button>
            </div>
            <div className="uvrow">
              <label>旋转</label>
              <input className="vslider" type="range" min={-180} max={180} step={1}
                value={Math.round((guv.rot * 180) / Math.PI)}
                onChange={e => setGlobalUv({ rot: (Number(e.target.value) * Math.PI) / 180 })} />
              <NumField value={Math.round((guv.rot * 180) / Math.PI)} step={1} min={-180} max={180}
                digits={0} width={58} reset={0} onChange={v => setGlobalUv({ rot: (v * Math.PI) / 180 })} />
            </div>
            <div className="uvrow">
              <label>位移 U</label>
              <input className="vslider" type="range" min={-1} max={1} step={0.01} value={guv.offsetU}
                onChange={e => setGlobalUv({ offsetU: Number(e.target.value) })} />
              <NumField value={guv.offsetU} step={0.01} min={-5} max={5} width={58} reset={0}
                onChange={v => setGlobalUv({ offsetU: v })} />
            </div>
            <div className="uvrow">
              <label>位移 V</label>
              <input className="vslider" type="range" min={-1} max={1} step={0.01} value={guv.offsetV}
                onChange={e => setGlobalUv({ offsetV: Number(e.target.value) })} />
              <NumField value={guv.offsetV} step={0.01} min={-5} max={5} width={58} reset={0}
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
                <input className="vslider" type="range" min={-1} max={1} step={0.01}
                  value={selCfg.intensity ?? 0} onChange={e => setChannel(selected, { intensity: Number(e.target.value) })} />
                <NumField value={selCfg.intensity ?? 0} step={0.01} min={-1} max={1}
                  width={66} reset={0} onChange={v => setChannel(selected, { intensity: v })} />
              </div>
            </div>
          )}

          {(selected === 'baseColor' || selected === 'emissive') && (
            <div className="param">
              <div className="plabel">HSL<span>色相 / 饱和度 / 明度</span></div>
              {([['h', 'H', -180, 180], ['s', 'S', -100, 100], ['l', 'L', -100, 100]] as const).map(([k, label, lo, hi]) => (
                <div className="uvrow" key={k}>
                  <label>{label}</label>
                  <input className="vslider" type="range" min={lo} max={hi} step={1}
                    value={(hsl as any)[k]} onChange={e => setHsl({ [k]: Number(e.target.value) } as any)} />
                  <NumField value={(hsl as any)[k]} step={1} min={lo} max={hi} digits={0} width={52} reset={0}
                    onChange={v => setHsl({ [k]: v } as any)} />
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

      {downOpen && downInfo && (
        <div className="modal-mask" onMouseDown={() => { if (!exporting) setDownOpen(false); }}>
          <div className="modal" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-t">降级贴图</div>
            <div className="hint" style={{ fontSize: 12 }}>
              当前：{downInfo.name}（{downInfo.w}×{downInfo.h}）。只能降低分辨率，不能升高。
            </div>
            <div className="uvrow">
              <label>目标</label>
              <select className="sortsel" value={downTarget} onChange={e => setDownTarget(Number(e.target.value))}>
                {[4096, 2048, 1024, 512].filter(v => v < Math.max(downInfo.w, downInfo.h)).map(v => (
                  <option key={v} value={v}>{v / 1024}K（{v}px）</option>
                ))}
              </select>
            </div>
            <div className="downopts">
              <label className="vp-check" onClick={() => setDownMode('rename')}>
                <span className={'box' + (downMode === 'rename' ? ' on' : '')}>{downMode === 'rename' ? '✓' : ''}</span>另存副本（改名）
              </label>
              <label className="vp-check" onClick={() => setDownMode('overwrite')}>
                <span className={'box' + (downMode === 'overwrite' ? ' on' : '')}>{downMode === 'overwrite' ? '✓' : ''}</span>覆盖原图（仅 PNG）
              </label>
            </div>
            <div className="modal-b">
              <button className="btn" disabled={exporting} onClick={() => setDownOpen(false)}>取消</button>
              <button className="btn primary" disabled={exporting} onClick={runDowngrade}>{exporting ? '处理中…' : '开始降级'}</button>
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
