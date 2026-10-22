/**
 * 把 SketchUp 读不了的模型临时导出成 GLB（只导出到数据目录，不改素材文件）。
 *
 * 为什么在渲染端做：three 的 FBXLoader 需要 DOM（贴图走 Image），Node 里跑不了；
 * 而且渲染端本来就在用同一套 loader 做预览，材质/贴图解析结果一致。
 *
 * 单位：FBX 的 GlobalSettings.UnitScaleFactor 表示「1 个文件单位 = 多少厘米」，
 * three 的 FBXLoader 只把它塞进 userData、不做换算，所以这里自己按 usf/100 折成米，
 * 再交给 GLTFExporter（glTF 约定 1 单位 = 1 米，SketchUp 按米读）。实测样本：
 *   Man_001.fbx   usf=100 raw 1.88  → 1.88 m（人）
 *   Door_001_01   usf=1   raw 242.4 → 2.42 m（门，厘米场景）
 */
import * as THREE from 'three';
import { assertBinaryFbx } from './fbxcheck';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildMaterial, detectConfig } from './matlib';

/** SketchUp 2026 自带导入器能直接吃的格式（无需转换） */
export const SU_NATIVE_EXT = new Set([
  '.skp', '.dae', '.dwg', '.dxf', '.3ds', '.glb', '.gltf', '.stl', '.ifc', '.kmz', '.usdz', '.trb'
]);

/** 软件可以用 three 读出来再转 GLB 的格式 */
export const CONVERTIBLE_EXT = new Set(['.fbx', '.obj', '.ply']);

export const extOf = (p: string) => {
  const m = String(p || '').match(/\.[a-z0-9]+$/i);
  return (m ? m[0] : '').toLowerCase();
};

/** 给软件侧判断用：这个扩展名能不能自动转 */
export function canConvertToGlb(ext: string) {
  return CONVERTIBLE_EXT.has(String(ext || '').toLowerCase());
}

export interface GlbExportStats {
  /** 源格式 */
  ext: string;
  /** 参与导出的网格数 / 材质数 */
  meshes: number;
  materials: number;
  /** 折算后的包围盒尺寸（米） */
  sizeM: [number, number, number];
  /** 应用的单位系数（1 表示原样） */
  unitScale: number;
  /** 原始最大边长（文件单位） */
  rawMax: number;
  /** 导出体积（字节） */
  glbBytes: number;
  /** 给用户看的补充说明 */
  note?: string;
}

export interface GlbExport {
  blob: Blob;
  stats: GlbExportStats;
}

interface DetailLike {
  files: { id: number; rel_path: string; role?: string; slot?: string | null }[];
  slotMap?: Record<string, string> | null;
}

/** 按文件名把相对引用映射到 /api/file/<id>，让 FBX/OBJ 的外部贴图也能读到 */
function managerFor(detail: DetailLike) {
  const byName = new Map<string, number>();
  for (const f of detail.files) {
    const bn = String(f.rel_path).split('/').pop();
    if (bn) byName.set(bn.toLowerCase(), f.id);
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (/^(data:|blob:|https?:)/i.test(url)) return url;
    let name = url;
    try { name = decodeURIComponent(url.split('?')[0]); } catch { /* keep */ }
    const id = byName.get(name.split('/').pop()!.toLowerCase());
    return id ? `/api/file/${id}` : url;
  });
  return manager;
}

function countMeshes(root: THREE.Object3D) {
  let meshes = 0;
  const names = new Set<string>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    meshes++;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) if (m && m.name) names.add(m.name);
  });
  return { meshes, materials: names.size };
}

/** 收集对象上所有的贴图（材质属性里 value.isTexture 的都算） */
function collectTextures(root: THREE.Object3D) {
  const seen = new Set<THREE.Texture>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of list) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const v: any = mat[key];
        if (v && v.isTexture && !seen.has(v)) seen.add(v);
      }
    }
  });
  return [...seen];
}

/**
 * 等贴图真的解码完再导出。
 * loader 的 Promise resolve 只代表几何解析完：three 的 TextureLoader 会**先**建 Texture 对象、
 * 之后才把 image 填进去，所以这里要轮询「每张贴图都有 image 且有像素」。
 * 否则 GLTFExporter 会整份抛「No valid image data found」。
 */
async function waitForTextures(root: THREE.Object3D, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const texs = collectTextures(root);
    if (!texs.length) return;
    const pending = texs.filter(t => {
      const im: any = t.image;
      if (!im) return true;
      const w = im.naturalWidth || im.width || im.videoWidth || 0;
      return !w || im.complete === false;
    });
    if (!pending.length) return;
    if (Date.now() > deadline) return;
    await Promise.all(pending.map(async t => {
      const im: any = t.image;
      if (im && typeof im.decode === 'function') {
        try { await im.decode(); } catch { /* 解不出来交给 sanitize 处理 */ }
      }
    }));
    await new Promise(r => setTimeout(r, 100));
  }
}

/** 把确实没有可用像素的贴图摘掉，避免整个导出失败（宁可少张贴图） */
function sanitizeTextures(root: THREE.Object3D): number {
  let dropped = 0;
  const texs = collectTextures(root);
  const dead = new Set<THREE.Texture>();
  for (const t of texs) {
    const img: any = t.image;
    const w = img?.naturalWidth || img?.width || img?.videoWidth || 0;
    if (!img || !w) dead.add(t);
  }
  if (!dead.size) return 0;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of list) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const v: any = mat[key];
        if (v && v.isTexture && dead.has(v)) { mat[key] = null; dropped++; }
      }
    }
  });
  return dropped;
}

/**
 * 把素材里的模型文件读进 three，套上（必要时）AssetManager 材质，导出 GLB。
 * 模型自带贴图的网格保持原样；一个贴图都没有的网格才套素材的材质 —— 与预览逻辑一致。
 */
export async function exportGlbForSketchUp(detail: DetailLike): Promise<GlbExport> {
  const files = detail.files || [];
  const cand = files.filter(f => CONVERTIBLE_EXT.has(extOf(f.rel_path)));
  if (!cand.length) throw new Error('这个素材里没有可转换的模型文件（只支持 FBX / OBJ / PLY）');
  // 多 LOD 时优先 slot 01
  const modelFile = cand.find(f => f.slot === '01') || cand[0];
  const ext = extOf(modelFile.rel_path);
  const manager = managerFor(detail);
  const url = `/api/file/${modelFile.id}`;

  let root: THREE.Object3D;
  if (ext === '.fbx') {
    const mf = files.find(f => extOf(f.rel_path) === '.fbx');
    if (mf) await assertBinaryFbx(mf.id, mf.rel_path);
    root = await new Promise<THREE.Group>((res, rej) => new FBXLoader(manager).load(url, res, undefined, rej));
  } else if (ext === '.obj') {
    const mtl = files.find(f => extOf(f.rel_path) === '.mtl');
    const loader = new OBJLoader(manager);
    if (mtl) {
      try {
        const mtlLoader = new MTLLoader(manager);
        const mats: any = await new Promise((res, rej) => mtlLoader.load(`/api/file/${mtl.id}`, res, undefined, rej));
        if (mats?.preload) mats.preload();
        loader.setMaterials(mats);
      } catch { /* 没材质也能导 */ }
    }
    root = await new Promise<THREE.Group>((res, rej) => loader.load(url, res, undefined, rej));
  } else {
    // PLY：只有几何
    const geo: THREE.BufferGeometry = await new Promise((res, rej) => new PLYLoader(manager).load(url, res, undefined, rej));
    geo.computeVertexNormals();
    root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7, metalness: 0 }));
  }

  // 没有贴图的网格套素材材质（贴图会随 GLB 一起嵌进去）
  let note: string | undefined;
  try {
    let blank = 0;
    root.traverse((o: any) => {
      if (!o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      const has = list.some((m: any) => m && (m.map || m.emissiveMap));
      if (!has) blank++;
    });
    if (blank > 0) {
      const mat = await buildMaterial(files as any, detectConfig(files as any, detail.slotMap || null));
      root.traverse((o: any) => {
        if (!o.isMesh) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        const has = list.some((m: any) => m && (m.map || m.emissiveMap));
        if (!has) {
          if (o.geometry?.attributes?.uv) o.geometry.setAttribute('uv1', o.geometry.attributes.uv);
          o.material = mat;
        }
      });
      note = `${blank} 个无贴图网格已套用素材材质`;
    }
  } catch {
    /* 材质套不上就让 GLB 白模走，SU 侧还有「无材质自动套基础色」兜底 */
  }

  // 单位：FBX 的 UnitScaleFactor 是「1 文件单位 = N 厘米」，折算成米
  const usf = Number((root as any).userData?.unitScaleFactor) || 0;
  const unitScale = usf > 0 ? usf / 100 : 1;
  if (unitScale !== 1) root.scale.multiplyScalar(unitScale);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const sizeM: [number, number, number] = [
    +size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)
  ];
  // 极端值提示（单位信息缺失时最容易出错）
  if (Math.max(...sizeM) > 500 || (Math.max(...sizeM) < 0.01 && Math.max(...sizeM) > 0)) {
    note = (note ? note + '；' : '') + `缩放异常（${sizeM.join(' × ')} m），可能缺少单位信息，导入后请核对`;
  }

  const { meshes, materials } = countMeshes(root);

  // 贴图必须真的解码完，否则 GLTFExporter 会整份失败
  await waitForTextures(root);
  const dropped = sanitizeTextures(root);
  if (dropped) note = (note ? note + '；' : '') + `${dropped} 张贴图没加载出来已略过`;

  const arrayBuffer = await new Promise<ArrayBuffer>((res, rej) => {
    new GLTFExporter().parse(root, (out: any) => res(out as ArrayBuffer), (e: any) => rej(e), {
      binary: true,
      maxTextureSize: 2048,
      onlyVisible: false,
      trs: true
    });
  });

  return {
    blob: new Blob([arrayBuffer], { type: 'model/gltf-binary' }),
    stats: {
      ext, meshes, materials, sizeM, unitScale, glbBytes: arrayBuffer.byteLength,
      rawMax: unitScale !== 1 ? +(Math.max(...sizeM) / unitScale).toFixed(2) : +Math.max(...sizeM).toFixed(2),
      note
    }
  };
}
