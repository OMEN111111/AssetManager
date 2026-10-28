/**
 * DCC 桥接核心：任务队列 / 心跳 / 安装 / 素材 → 任务载荷
 *
 * 结构与 docs/06-桥接插件设计.md 一致：
 *   AssetManager(HTTP) ⇄ 插件轮询（500~1000ms）+ 心跳（2s）+ 结果回报
 * 队列里只放「文件绝对路径」，大文件不走 HTTP；只监听 127.0.0.1，不做鉴权。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assetUuid } from './db.ts';
import type { DB } from './db.ts';

/** 插件协议版本（服务端 + .ms 一起改） */
export const BRIDGE_PROTOCOL = 1;
/** 插件脚本版本（面板显示；与应用版本保持一致，第三位递增） */
export const BRIDGE_SCRIPT_VERSION = '0.2.1';

const LEASE_MS = 90_000;
const CONNECTED_MS = 6000;
const DEDUPE_MS = 30_000;

export type BridgeTarget = 'max' | 'su' | 'blender' | 'houdini' | 'ue' | 'maya';

export const TARGET_LABEL: Record<string, string> = {
  max: '3ds Max',
  su: 'SketchUp',
  blender: 'Blender',
  houdini: 'Houdini',
  ue: 'Unreal Engine',
  maya: 'Maya'
};

export const MODE_LABEL: Record<string, string> = {
  import: '导入模型',
  material: '创建材质',
  texture: '发送贴图',
  hdri: '应用 HDRI',
  ies: '发送 IES'
};

/** 各模式支持的 DCC（IES 只有 UE / Maya(Arnold) 原生支持） */
export const MODE_TARGETS: Record<string, BridgeTarget[]> = {
  import: ['max', 'blender', 'su', 'ue', 'maya'],
  material: ['max', 'blender', 'su', 'ue', 'maya'],
  texture: ['max', 'blender', 'su', 'ue', 'maya'],
  hdri: ['max', 'blender', 'su', 'ue', 'maya'],
  ies: ['ue', 'maya']
};

// 表结构在 core/db.ts 的 SCHEMA 中（随数据库打开自动创建）

// ---------------------------------------------------------------- 载荷

export interface MapEntry {
  /** 绝对路径 */
  path: string;
  /** rgb / r / g / b / a（AO、粗糙度、金属度这类单通道贴图用 R/G/B 抽取） */
  channel: 'rgb' | 'r' | 'g' | 'b' | 'a';
  intensity?: number;
  invert?: boolean;
  normalSpace?: 'gl' | 'dx';
  hsl?: { h: number; s: number; l: number };
}

export interface MaterialSpec {
  name: string;
  /** MR = 金属-粗糙；SG = 高光-光泽（Relink/旧库） */
  workflow: 'MR' | 'SG';
  maps: Record<string, MapEntry>;
  uv?: { repeatU: number; repeatV: number; rot: number; offsetU: number; offsetV: number };
}

const IMG_RE = /\.(png|jpe?g|webp|tga|tif|tiff|exr|dds|psd|hdr|bmp)$/i;

interface FileRow { id: number; rel_path: string; role: string; slot: string | null }

interface AssetBundle {
  root: string;
  asset: any;
  files: FileRow[];
}

function loadBundle(db: DB, assetId: number): AssetBundle | null {
  const a = db.prepare(`SELECT a.*, l.root FROM assets a JOIN libraries l ON l.id=a.library_id WHERE a.id=?`)
    .get(assetId) as any;
  if (!a) return null;
  const files = db.prepare('SELECT id,rel_path,role,slot FROM files WHERE asset_id=?').all(assetId) as FileRow[];
  return { root: a.root, asset: a, files };
}

const abs = (root: string, rel: string) => path.join(root, rel.split('/').join(path.sep));
const isImg = (rel: string) => IMG_RE.test(rel);
const lc = (s: string) => s.toLowerCase();

/** 通道识别规则：先判 packed（ARM/ORM 打包图），再判单通道 */
const RULES: { key: string; re: RegExp; channel: MapEntry['channel'] }[] = [
  { key: 'opacity', re: /(opacity|_alpha|alpha\.)/i, channel: 'r' },
  { key: 'emissive', re: /(emissive|emission|_emit)/i, channel: 'rgb' },
  { key: 'normal', re: /(normal|nor_gl|nor_dx|_nrm)/i, channel: 'rgb' },
  { key: 'baseColor', re: /(basecolor|base_color|albedo|diffuse|_diff|_col\b|color)/i, channel: 'rgb' },
  { key: 'roughness', re: /(roughness|_rough|rough_)/i, channel: 'r' },
  { key: 'metallic', re: /(metallic|metal)/i, channel: 'r' },
  { key: 'ao', re: /(_ao\b|ambient|occlusion)/i, channel: 'r' },
  { key: 'height', re: /(height|displacement|_disp)/i, channel: 'r' }
];

/** 无 material_json 时按文件名猜通道（与渲染端 detectConfig 保持一致） */
function detectSpec(name: string, bundle: AssetBundle): MaterialSpec {
  const maps: Record<string, MapEntry> = {};
  const images = bundle.files.filter(f => isImg(f.rel_path));
  const findRe = (re: RegExp) => images.find(f => re.test(lc(f.rel_path)));

  const packed = findRe(/(_arm[._]|_orm[._]|_omr[._]|_rma[._])/i);
  if (packed) {
    const p = lc(packed.rel_path);
    const isOmr = p.includes('_omr_');
    const file = abs(bundle.root, packed.rel_path);
    maps.ao = { path: file, channel: 'r', intensity: 1 };
    maps.roughness = { path: file, channel: isOmr ? 'b' : 'g', intensity: 1 };
    maps.metallic = { path: file, channel: isOmr ? 'g' : 'b', intensity: 1 };
  }

  for (const rule of RULES) {
    if (rule.key === 'roughness' || rule.key === 'metallic' || rule.key === 'ao') {
      if (packed) continue;
    }
    if (maps[rule.key]) continue;
    const hit = findRe(rule.re);
    if (!hit) continue;
    const entry: MapEntry = { path: abs(bundle.root, hit.rel_path), channel: rule.channel, intensity: 1 };
    if (rule.key === 'normal') entry.normalSpace = /(_dx|dx_|directx)/i.test(lc(hit.rel_path)) ? 'dx' : 'gl';
    if (rule.key === 'height') entry.intensity = 0.04;
    maps[rule.key] = entry;
  }
  return { name, workflow: 'MR', maps };
}

/** 有 material_json（材质组装器保存的配置）时按它生成，通道/强度/UV 都还原 */
function specFromConfig(name: string, bundle: AssetBundle, cfg: any): MaterialSpec {
  const byId = new Map(bundle.files.map(f => [f.id, f]));
  const maps: Record<string, MapEntry> = {};
  const ch = cfg?.channels || {};
  for (const key of Object.keys(ch)) {
    const c = ch[key];
    if (!c || !c.fileId) continue;
    const f = byId.get(Number(c.fileId));
    if (!f) continue;
    const entry: MapEntry = {
      path: abs(bundle.root, f.rel_path),
      channel: (c.channel || 'rgb') as MapEntry['channel'],
      intensity: typeof c.intensity === 'number' ? c.intensity : 1
    };
    if (c.invert) entry.invert = true;
    if (key === 'normal') entry.normalSpace = c.normalSpace === 'dx' ? 'dx' : 'gl';
    if (c.hsl) entry.hsl = { h: c.hsl.h || 0, s: c.hsl.s || 0, l: c.hsl.l || 0 };
    maps[key] = entry;
  }
  const spec: MaterialSpec = { name, workflow: cfg?.workflow === 'SG' ? 'SG' : 'MR', maps };
  if (cfg?.uv && (cfg.uv.repeatU || cfg.uv.repeatV || cfg.uv.rot || cfg.uv.offsetU || cfg.uv.offsetV)) {
    spec.uv = {
      repeatU: cfg.uv.repeatU || 1, repeatV: cfg.uv.repeatV || 1, rot: cfg.uv.rot || 0,
      offsetU: cfg.uv.offsetU || 0, offsetV: cfg.uv.offsetV || 0
    };
  }
  return spec;
}

function materialSpec(bundle: AssetBundle): MaterialSpec {
  const name = String(bundle.asset.name || 'Material');
  let cfg: any = null;
  if (bundle.asset.material_json) {
    try { cfg = JSON.parse(bundle.asset.material_json); } catch { cfg = null; }
  }
  const spec = cfg ? specFromConfig(name, bundle, cfg) : detectSpec(name, bundle);
  if (!Object.keys(spec.maps).length) return detectSpec(name, bundle);
  return spec;
}

/** maps 槽位 → 绝对路径数组（模型导入时做参考与兜底） */
function mapsBySlot(spec: MaterialSpec): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(spec.maps)) out[k] = [v.path];
  return out;
}

function modelFile(bundle: AssetBundle): FileRow | null {
  const models = bundle.files.filter(f => f.role === 'model' || f.role === 'main');
  if (!models.length) {
    const byExt = bundle.files.find(f => /\.(fbx|obj|glb|gltf|stl|3ds|abc|usdz|usd|usda|usdc|blend|max)$/i.test(f.rel_path));
    return byExt || null;
  }
  // 多 LOD / 多尺寸：优先 slot 01
  return models.find(f => f.slot === '01') || models[0];
}

/** 素材 → 任务载荷（modelOverride：软件临时导出的 GLB 等替代模型文件） */
export function buildPayload(db: DB, assetId: number, mode: string, modelOverride?: string, options?: any) {
  const bundle = loadBundle(db, assetId);
  if (!bundle) return { error: 'asset not found' as const };
  const a = bundle.asset;
  const spec = materialSpec(bundle);

  // F-007：模型/材质里手动指定的贴图覆盖，优先于自动匹配
  try {
    const key = `${a.rel_dir}|${a.name}|${a.type}`;
    const ovs = db.prepare('SELECT material, channel, file_rel, swizzle FROM material_overrides WHERE asset_key=?').all(key) as any[];
    for (const r of ovs) {
      if (r.material !== spec.name && r.material !== a.name) continue;
      const ch = String(r.channel);
      const entry: MapEntry = {
        path: abs(bundle.root, r.file_rel),
        channel: ['r', 'g', 'b'].includes(String(r.swizzle || ''))
          ? String(r.swizzle)
          : ((ch === 'baseColor' || ch === 'emissive' || ch === 'normal') ? 'rgb' : 'r'),
        intensity: ch === 'height' ? 0.04 : 1
      };
      if (ch === 'normal') entry.normalSpace = 'gl';
      spec.maps[ch] = entry;
    }
  } catch { /* table may not exist on old DBs */ }

  const sourceDir = path.join(bundle.root, String(a.rel_dir));

  if (mode === 'import') {
    const m = modelFile(bundle);
    const override = modelOverride && fs.existsSync(modelOverride) ? modelOverride : '';
    if (!m && !override) return { error: '该素材没有可导入的模型文件' as const };
    // 软件临时导出的 GLB（FBX/OBJ 等 SketchUp 读不了的格式）直接用它
    const path2 = override || abs(bundle.root, m!.rel_path);
    // USD 自带材质与贴图（按 prim 绑定，还可能是跨层引用），DCC 直接导入就是对的；
    // 这时候再让插件拿「按文件名匹配」的材质去覆盖，反而会把材质串掉 —— 所以不带 material。
    const isUsd = /\.(usd|usda|usdc|usdz)$/i.test(path2);
    // 导入类型（只有 UE 用得到）：静态网格体 / 骨骼网格体 / 物理资产，默认只静态
    const io = options?.importOptions || {};
    return {
      payload: {
        assetId,
        uuid: assetUuid(db, assetId),
        name: String(a.name),
        sourceDir,
        modelPath: path2,
        ext: path.extname(path2).toLowerCase(),
        material: isUsd ? null : spec,
        maps: isUsd ? {} : mapsBySlot(spec),
        converted: !!override,
        importOptions: {
          staticMesh: io.staticMesh !== false,
          skeletalMesh: io.skeletalMesh === true,
          physicsAsset: io.physicsAsset === true,
          placeInViewport: io.placeInViewport === true
        }
      }
    };
  }

  if (mode === 'material') {
    if (!Object.keys(spec.maps).length) return { error: '该素材没有可用的贴图' as const };
    // 父材质（只有 UE 用得到）：给了路径 → UE 基于它建材质实例；留空 → 独立材质
    const parent = String(options?.parentMaterial || '').trim();
    return {
      payload: {
        ...spec, assetId, assetName: String(a.name), sourceDir,
        ...(parent ? { parentMaterial: parent } : {})
      }
    };
  }

  if (mode === 'texture') {
    const images = bundle.files.filter(f => isImg(f.rel_path) && f.role !== 'preview');
    if (!images.length) return { error: '该素材没有贴图文件' as const };
    return {
      payload: {
        assetId,
        name: String(a.name),
        sourceDir,
        files: images.map(f => abs(bundle.root, f.rel_path)),
        paths: images.map(f => ({ path: abs(bundle.root, f.rel_path), role: f.role }))
      }
    };
  }

  // HDRI：只有 SketchUp 这类原生支持「环境/天空」的 DCC 用得到（.hdr/.exr）
  if (mode === 'hdri') {
    const envs = bundle.files.filter(f => /\.(hdr|exr)$/i.test(f.rel_path));
    if (!envs.length) return { error: '该素材里没有 .hdr / .exr 文件' as const };
    return {
      payload: {
        assetId,
        name: String(a.name),
        sourceDir,
        files: envs.map(f => abs(bundle.root, f.rel_path)),
        paths: envs.map(f => ({ path: abs(bundle.root, f.rel_path), role: f.role })),
        hdriApply: {
          env: options?.env !== false,
          viewport: options?.viewport !== false
        }
      }
    };
  }

  // IES 配光文件：UE 原生支持（TextureLightProfile → SpotLight/PointLight 的 IESTexture）
  if (mode === 'ies') {
    const ies = bundle.files.filter(f => /\.(ies|ldt)$/i.test(f.rel_path));
    if (!ies.length) return { error: '该素材里没有 .ies 文件' as const };
    return {
      payload: {
        assetId,
        name: String(a.name),
        sourceDir,
        files: ies.map(f => abs(bundle.root, f.rel_path)),
        paths: ies.map(f => ({ path: abs(bundle.root, f.rel_path), role: f.role }))
      }
    };
  }

  return { error: '未知模式' as const };
}

// ---------------------------------------------------------------- SketchUp 格式判断

/**
 * SketchUp 2026 自带导入器能直接吃的格式（与插件 main.rb 的 SUPPORTED_IMPORT 保持一致）。
 * FBX / OBJ 不在其中 —— 这类要先在软件里临时转成 GLB。
 */
export const SU_IMPORT_EXT = [
  '.skp', '.dae', '.dwg', '.dxf', '.3ds', '.glb', '.gltf', '.stl', '.ifc', '.kmz', '.usdz', '.trb'
];
/** 软件能临时转成 GLB 的格式（渲染端 three 的 loader 支持） */
export const SU_CONVERTIBLE_EXT = ['.fbx', '.obj', '.ply'];

/**
 * 在线的 SketchUp 客户端能不能吃 GLB：
 * 2024 起才带 glbimporter.dll，2022 / 2023 没有（插件心跳里报 `glb`，没有就按版本号推断）。
 * 拿不到客户端信息时按「支持」处理，别把正常流程挡住。
 */
export function suClientSupportsGlb(db: DB): boolean {
  try {
    const row = db.prepare('SELECT info FROM bridge_clients WHERE target=?').get('su') as any;
    if (!row || !row.info) return true;
    const info = JSON.parse(String(row.info));
    if (typeof info.glb === 'boolean') return info.glb;
    const major = parseInt(String(info.sketchup || '').split('.')[0], 10);
    if (Number.isFinite(major) && major > 0) return major >= 24;
    return true;
  } catch {
    return true;
  }
}

/**
 * 发给 SketchUp 导入前要不要先转 GLB：
 *   null                       → 不用转（SketchUp 自己能读）
 *   { convertible: false }     → 转不了（比如 .blend/.max），得给用户说清楚
 *   { convertible: true }      → 软件侧转 GLB 后再发
 */
export function suConvertCheck(db: DB, assetId: number) {
  const bundle = loadBundle(db, assetId);
  if (!bundle) return null;
  const m = modelFile(bundle);
  if (!m || !m.rel_path) return null;
  const ext = path.extname(m.rel_path).toLowerCase();
  if (SU_IMPORT_EXT.includes(ext)) return null;
  return {
    ext,
    convertible: SU_CONVERTIBLE_EXT.includes(ext),
    name: String(bundle.asset.name),
    modelPath: abs(bundle.root, m.rel_path)
  };
}

// ---------------------------------------------------------------- 路径反查

/**
 * 把一个文件路径反查成素材（拖放/回写用）。
 * 文件可能就在素材目录里，也可能在 maps/ 之类的子目录。
 */
export function resolvePath(db: DB, filePath: string) {
  if (!filePath) return null;
  const norm = path.resolve(filePath);
  const lower = norm.toLowerCase();
  const libs = db.prepare('SELECT id, root, name FROM libraries').all() as any[];
  let best: { id: number; relDir: string; root: string; libraryId: number } | null = null;

  for (const l of libs) {
    const root = path.resolve(l.root);
    if (!lower.startsWith((root + path.sep).toLowerCase())) continue;
    const rel = path.relative(root, norm).split(path.sep).join('/');
    const rows = db.prepare('SELECT id, rel_dir FROM assets WHERE library_id=?').all(l.id) as any[];
    for (const a of rows) {
      const dir = String(a.rel_dir);
      if (rel === dir || rel.startsWith(dir + '/')) {
        if (!best || dir.length > best.relDir.length) best = { id: a.id, relDir: dir, root, libraryId: l.id };
      }
    }
  }
  if (!best) return null;

  const bundle = loadBundle(db, best.id);
  if (!bundle) return null;
  const a = bundle.asset;
  const spec = materialSpec(bundle);
  const m = modelFile(bundle);
  return {
    assetId: a.id,
    name: String(a.name),
    type: String(a.type),
    libraryId: best.libraryId,
    sourceDir: path.join(best.root, best.relDir),
    relDir: best.relDir,
    ext: a.ext,
    modelPath: m ? abs(best.root, m.rel_path) : null,
    material: spec,
    maps: mapsBySlot(spec),
    files: bundle.files.map(f => ({ path: abs(best.root, f.rel_path), role: f.role }))
  };
}

/** 素材 → 工具栏需要的源目录/文件信息 */
export function assetInfo(db: DB, assetId: number) {
  const bundle = loadBundle(db, assetId);
  if (!bundle) return null;
  const a = bundle.asset;
  const m = modelFile(bundle);
  const root = path.dirname(path.join(bundle.root, m ? m.rel_path : 'x'));
  return {
    assetId: a.id,
    name: String(a.name),
    type: String(a.type),
    sourceDir: path.join(bundle.root, String(a.rel_dir)),
    modelPath: m ? abs(bundle.root, m.rel_path) : null,
    files: bundle.files.map(f => ({ path: abs(bundle.root, f.rel_path), role: f.role }))
  };
}

// ---------------------------------------------------------------- 拖放描述文件

/** 拖出时给 3ds Max 的「描述文件」：一个极小的 .ms，Max 拖入即执行 */
export function writeDropScript(db: DB, assetId: number, appRoot: string) {
  const bundle = loadBundle(db, assetId);
  if (!bundle) return null;
  const a = bundle.asset;
  const m = modelFile(bundle);
  const primary = m ? abs(bundle.root, m.rel_path) : (() => {
    const img = bundle.files.find(f => isImg(f.rel_path) && f.role !== 'preview');
    if (img) return abs(bundle.root, img.rel_path);
    const any = bundle.files.find(f => f.role !== 'preview');
    return any ? abs(bundle.root, any.rel_path) : '';
  })();
  const kind = String(a.type); // model / material / texture / hdri / scene / ...
  const bridge = maxScriptPathForDrop(appRoot);
  const sourceDir = path.join(bundle.root, String(a.rel_dir));
  const modelPath = m ? abs(bundle.root, m.rel_path) : '';
  const uuid = assetUuid(db, assetId);

  const dir = process.env.AM_WORKSPACE
    ? path.join(process.env.AM_WORKSPACE, 'cache', 'drops')
    : path.join(os.tmpdir(), 'AssetManager', 'drops');
  let file = path.join(dir, `am-drop-${assetId}.ms`);
  const verbatim = (p: string) => '@"' + String(p).replace(/"/g, '""') + '"';
  const body = [
    `-- AssetManager 拖放描述文件（自动生成，可删）`,
    `-- 素材：${String(a.name).replace(/[\r\n]/g, ' ')}`,
    `(`,
    `  -- MAXScript 不支持前向引用：先声明成全局，后面 fileIn 定义它才找得到`,
    `  global amb_drop_asset`,
    `  local ok = true`,
    `  local err = ""`,
    `  try (`,
    `    -- 每次都先加载当前脚本：Max 里可能还留着旧版本（进程不重启就不会更新）`,
    `    try (fileIn ${verbatim(bridge)}) catch ()`,
    `    -- 参数：id、代表文件、类型、源目录、名称、模型文件、UUID（导回时按 UUID 认资产）`,
    `    amb_drop_asset ${assetId} ${verbatim(primary)} ${JSON.stringify(kind)} ${verbatim(sourceDir)} ${verbatim(String(a.name))} ${verbatim(modelPath)} uuid:${verbatim(uuid)}`,
    `  ) catch (ok = false; err = try ((getCurrentException()) as string) catch ("?"))`,
    `  if not ok do (`,
    `    try (messageBox ("AssetManager 拖放失败：\\n" + err + "\\n\\n请确认 AssetManager 正在运行，并且插件已安装到 3ds Max。") title:"AssetManager") catch ()`,
    `  )`,
    `)`,
    ''
  ].join('\r\n');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  } catch {
    return null;
  }
  return { path: file, kind, primary, name: String(a.name) };
}

/** 描述文件里 fileIn 的路径：优先用已安装到 Max startup 的那份（asar 路径 MAXScript 读不了） */
function maxScriptPathForDrop(appRoot: string) {
  try {
    const info = installInfo(appRoot);
    const installed = (info.installedAt || []).find((p: string) => fs.existsSync(p.replace(/ \(版本不同\)$/, '')));
    if (installed) return installed.replace(/ \(版本不同\)$/, '');
  } catch { /* ignore */ }
  return bridgeScriptPath(appRoot);
}

// ---------------------------------------------------------------- 队列

function parsePayload(row: any) {
  let payload: any = {};
  try { payload = JSON.parse(row.payload); } catch { /* keep {} */ }
  return { id: row.id, target: row.target, mode: row.mode, title: row.title, payload };
}

export function sendJob(
  db: DB, assetId: number, target: string, mode: string,
  opts?: { modelPath?: string; titleSuffix?: string; options?: any }
) {
  const b = buildPayload(db, assetId, mode, opts?.modelPath, opts?.options);
  if ('error' in b) return b;
  const now = Date.now();

  // 防重复点击：同一素材 + 模式在 30s 内已有排队/执行中的任务，直接复用
  const dup = db.prepare(`SELECT * FROM bridge_jobs
    WHERE target=? AND asset_id=? AND mode=? AND status IN ('pending','running') AND created_at > ?
    ORDER BY id DESC LIMIT 1`).get(target, assetId, mode, now - DEDUPE_MS) as any;
  if (dup) return { id: dup.id, reused: true, status: dup.status };

  const asset = db.prepare('SELECT name FROM assets WHERE id=?').get(assetId) as any;
  const title = `${asset?.name || '素材'} · ${MODE_LABEL[mode] || mode}${opts?.titleSuffix || ''}`;
  const info = db.prepare(`INSERT INTO bridge_jobs(target,asset_id,mode,title,payload,status,created_at)
    VALUES(?,?,?,?,?,'pending',?)`).run(target, assetId, mode, title, JSON.stringify(b.payload), now);
  return { id: Number(info.lastInsertRowid), title };
}

/** 取下一个任务：把 pending 转 running 并加租约；没有则 null */
export function nextJob(db: DB, target: string) {
  const now = Date.now();
  // 租约过期的任务（Max 崩溃/关闭）退回 pending，避免卡死
  db.prepare(`UPDATE bridge_jobs SET status='pending', lease_until=NULL
    WHERE target=? AND status='running' AND lease_until IS NOT NULL AND lease_until < ?`).run(target, now);

  const row = db.prepare(`SELECT * FROM bridge_jobs WHERE target=? AND status='pending' ORDER BY id LIMIT 1`)
    .get(target) as any;
  if (!row) return null;
  const upd = db.prepare(`UPDATE bridge_jobs SET status='running', started_at=?, lease_until=?
    WHERE id=? AND status='pending'`).run(now, now + LEASE_MS, row.id);
  if (!Number(upd.changes)) return null;
  return parsePayload(row);
}

export function finishJob(db: DB, target: string, id: number, ok: boolean, message?: string, detail?: any) {
  const row = db.prepare('SELECT * FROM bridge_jobs WHERE id=? AND target=?').get(id, target) as any;
  if (!row) return { ok: false, error: 'job not found' };
  db.prepare(`UPDATE bridge_jobs SET status=?, message=?, result=?, finished_at=?, lease_until=NULL WHERE id=?`)
    .run(ok ? 'done' : 'failed', String(message || '').slice(0, 2000),
      detail === undefined ? null : JSON.stringify(detail), Date.now(), id);
  return { ok: true, id, status: ok ? 'done' : 'failed' };
}

export function heartbeat(db: DB, target: string, version?: string, host?: string, info?: any) {  const now = Date.now();
  db.prepare(`INSERT INTO bridge_clients(target,last_seen,version,host,info) VALUES(?,?,?,?,?)
    ON CONFLICT(target) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version,
      host=excluded.host, info=excluded.info`)
    .run(target, now, version || '', host || '', info ? JSON.stringify(info) : null);
  return { ok: true, at: now };
}

/** 轮询取任务时顺手刷新在线时间（心跳包丢了也不会误判离线）
 *
 * 没有客户端行时补一条：能取任务本身就说明插件活着，
 * 万一心跳因为别的原因发不出去（比如插件跨线程调了引擎 API），界面也不该一直显示未连接。
 */
export function touchClient(db: DB, target: string) {
  try {
    const now = Date.now();
    const r = db.prepare('UPDATE bridge_clients SET last_seen=? WHERE target=?').run(now, target);
    if (!Number(r.changes)) {
      db.prepare('INSERT OR IGNORE INTO bridge_clients(target,last_seen,version,host,info) VALUES(?,?,?,?,NULL)')
        .run(target, now, '', '');
    }
  } catch { /* ignore */ }
}

export function jobById(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM bridge_jobs WHERE id=?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id, target: row.target, mode: row.mode, title: row.title, status: row.status,
    message: row.message, result: row.result ? safeParse(row.result) : null,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at
  };
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}

export function recentJobs(db: DB, target: string, limit = 20) {
  const rows = db.prepare(`SELECT id,target,mode,title,status,message,result,created_at,finished_at
    FROM bridge_jobs WHERE target=? ORDER BY id DESC LIMIT ?`).all(target, Math.min(limit, 100)) as any[];
  return rows.map(r => ({
    id: r.id, target: r.target, mode: r.mode, title: r.title, status: r.status,
    message: r.message, createdAt: r.created_at, finishedAt: r.finished_at,
    result: r.result ? safeParse(r.result) : null
  }));
}

export function bridgeStatus(db: DB) {
  const now = Date.now();
  const targets = [...new Set([
    ...(db.prepare('SELECT DISTINCT target FROM bridge_clients').all() as any[]).map(r => r.target),
    ...(db.prepare('SELECT DISTINCT target FROM bridge_jobs').all() as any[]).map(r => r.target)
  ])];
  const out: Record<string, any> = {};
  for (const t of targets) {
    const c = db.prepare('SELECT * FROM bridge_clients WHERE target=?').get(t) as any;
    const queued = (db.prepare("SELECT COUNT(*) c FROM bridge_jobs WHERE target=? AND status='pending'").get(t) as any).c;
    const running = (db.prepare("SELECT COUNT(*) c FROM bridge_jobs WHERE target=? AND status='running'").get(t) as any).c;
    const last = db.prepare('SELECT * FROM bridge_jobs WHERE target=? ORDER BY id DESC LIMIT 1').get(t) as any;
    out[t] = {
      target: t,
      label: TARGET_LABEL[t] || t,
      connected: !!c && now - c.last_seen < CONNECTED_MS,
      lastSeen: c?.last_seen ?? null,
      version: c?.version || '',
      host: c?.host || '',
      queued, running,
      lastJob: last ? { id: last.id, title: last.title, status: last.status, message: last.message, finishedAt: last.finished_at } : null
    };
  }
  // 3ds Max 即使在没连过时也要有一张卡片
  if (!out.max) {
    out.max = { target: 'max', label: TARGET_LABEL.max, connected: false, lastSeen: null, version: '', host: '', queued: 0, running: 0, lastJob: null };
  }
  return { app: 'AssetManager', protocol: BRIDGE_PROTOCOL, scriptVersion: BRIDGE_SCRIPT_VERSION, now, targets: out };
}

// ---------------------------------------------------------------- Blender 安装

const BLENDER_PLUGIN_FILE = 'assetmanager_blender.py';

/** 安装包里有哪些 Blender 系列目录（3.6 / 4.0 / 5.2 …） */
export function blenderSeries(appRoot: string): string[] {
  const dir = path.join(appRoot, 'bridge', 'blender');
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && /^\d+\.\d+$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      return (pa[0] - pb[0]) || (pa[1] - pb[1]);
    });
}

/** 本机 Blender 的用户目录（%APPDATA%\Blender Foundation\Blender\<版本>\scripts\addons） */
export function blenderUserDirs(): { version: string; addons: string }[] {
  const appdata = process.env.APPDATA
    || path.join(os.homedir(), 'AppData', 'Roaming');
  const base = path.join(appdata, 'Blender Foundation', 'Blender');
  let versions: fs.Dirent[] = [];
  try { versions = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out: { version: string; addons: string }[] = [];
  for (const v of versions) {
    if (!v.isDirectory() || !/^\d+\.\d+$/.test(v.name)) continue;
    const dir = path.join(base, v.name, 'scripts', 'addons');
    // 只认真的被 Blender 用过的版本目录（有 config 或 datafiles 才算）
    const used = fs.existsSync(path.join(base, v.name, 'config'))
      || fs.existsSync(path.join(base, v.name, 'datafiles'))
      || fs.existsSync(dir);
    if (used) out.push({ version: v.name, addons: dir });
  }
  return out;
}

/** 给某个 Blender 版本挑最合适的插件系列：优先同版本，其次不超过它的最高系列 */
export function pickBlenderSeries(series: string[], blenderVersion: string): string | null {
  if (!series.length) return null;
  if (series.includes(blenderVersion)) return blenderVersion;
  const [bmaj, bmin] = blenderVersion.split('.').map(Number);
  const le = series.filter(s => {
    const [maj, min] = s.split('.').map(Number);
    return maj < bmaj || (maj === bmaj && min <= bmin);
  });
  if (le.length) return le[le.length - 1];
  return series[0]; // Blender 比所有系列都老：给最低的那份
}

function pluginVersionOf(src: string): string {
  try {
    const m = fs.readFileSync(src, 'utf8').match(/BL_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** 一键把插件装进本机所有 Blender 用户目录（按各版本挑对应系列） */
export function installForBlender(appRoot: string) {
  const series = blenderSeries(appRoot);
  if (!series.length) {
    return { ok: false, error: '安装包缺少 bridge/blender/<Blender 版本>/ 目录（重新打包）' };
  }
  const dirs = blenderUserDirs();
  if (!dirs.length) {
    return {
      ok: false,
      error: '没找到 Blender 用户目录（%APPDATA%\\Blender Foundation\\Blender）：先启动一次 Blender 再装',
      series
    };
  }

  const installed: { blender: string; series: string; version: string; dir: string }[] = [];
  const failed: { blender: string; error: string }[] = [];
  for (const d of dirs) {
    const pick = pickBlenderSeries(series, d.version);
    if (!pick) continue;
    const src = path.join(appRoot, 'bridge', 'blender', pick, BLENDER_PLUGIN_FILE);
    if (!fs.existsSync(src)) {
      failed.push({ blender: d.version, error: `缺少 ${pick}/${BLENDER_PLUGIN_FILE}` });
      continue;
    }
    try {
      fs.mkdirSync(d.addons, { recursive: true });
      const dst = path.join(d.addons, BLENDER_PLUGIN_FILE);
      fs.copyFileSync(src, dst);
      installed.push({ blender: d.version, series: pick, version: pluginVersionOf(dst), dir: dst });
    } catch (e: any) {
      failed.push({ blender: d.version, error: String(e?.message || e) });
    }
  }
  return { ok: installed.length > 0, installed, failed, series, dirs: dirs.map(d => d.addons) };
}

// ---------------------------------------------------------------- SketchUp 安装

/** SketchUp 插件的两个文件：加载器 + 同名实现文件夹（Plugins 下就是这个结构） */
const SU_LOADER = 'assetmanager_su.rb';
const SU_DIR = 'assetmanager_su';

/** 安装包里有哪些 SketchUp 系列目录（2026 / 2025 …） */
export function suSeries(appRoot: string): string[] {
  const dir = path.join(appRoot, 'bridge', 'su');
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => Number(a) - Number(b));
}

/** 本机 SketchUp 的 Plugins 目录（%APPDATA%\SketchUp\SketchUp 2026\SketchUp\Plugins） */
export function suUserDirs(): { version: string; plugins: string }[] {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const base = path.join(appdata, 'SketchUp');
  let versions: fs.Dirent[] = [];
  try { versions = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out: { version: string; plugins: string }[] = [];
  for (const v of versions) {
    if (!v.isDirectory()) continue;
    const m = v.name.match(/^SketchUp\s+(\d{4})$/i);
    if (!m) continue;
    const inner = path.join(base, v.name, 'SketchUp');
    // 只认真正用过的版本目录（里面会有 Plugins 或 SharedPreferences.json）
    const used = fs.existsSync(path.join(inner, 'Plugins')) || fs.existsSync(path.join(inner, 'SharedPreferences.json'));
    if (!used) continue;
    out.push({ version: m[1], plugins: path.join(inner, 'Plugins') });
  }
  return out;
}

/** 给某个 SketchUp 版本挑系列：优先同版本，其次不超过它的最高系列 */
export function pickSuSeries(series: string[], suVersion: string): string | null {
  if (!series.length) return null;
  if (series.includes(suVersion)) return suVersion;
  const le = series.filter(s => Number(s) <= Number(suVersion));
  if (le.length) return le[le.length - 1];
  return series[0];
}

function suPluginVersionOf(loader: string): string {
  try {
    const m = fs.readFileSync(loader, 'utf8').match(/AM_PLUGIN_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch { return ''; }
}

/** 一键把 SketchUp 插件装进本机所有 SketchUp 用户目录（按各版本挑对应系列） */
export function installForSu(appRoot: string) {
  const series = suSeries(appRoot);
  if (!series.length) {
    return { ok: false, error: '安装包缺少 bridge/su/<SketchUp 版本>/ 目录（重新打包）' };
  }
  const dirs = suUserDirs();
  if (!dirs.length) {
    return {
      ok: false,
      error: '没找到 SketchUp 用户目录（%APPDATA%\\SketchUp\\SketchUp 20XX\\SketchUp\\Plugins）：先启动一次 SketchUp 再装',
      series
    };
  }

  const installed: { sketchup: string; series: string; version: string; dir: string }[] = [];
  const failed: { sketchup: string; error: string }[] = [];
  for (const d of dirs) {
    const pick = pickSuSeries(series, d.version);
    if (!pick) continue;
    const srcLoader = path.join(appRoot, 'bridge', 'su', pick, SU_LOADER);
    const srcDir = path.join(appRoot, 'bridge', 'su', pick, SU_DIR);
    if (!fs.existsSync(srcLoader) || !fs.existsSync(srcDir)) {
      failed.push({ sketchup: d.version, error: `缺少 ${pick}/${SU_LOADER} 或 ${pick}/${SU_DIR}/` });
      continue;
    }
    try {
      fs.mkdirSync(path.join(d.plugins, SU_DIR), { recursive: true });
      const dstLoader = path.join(d.plugins, SU_LOADER);
      fs.copyFileSync(srcLoader, dstLoader);
      fs.copyFileSync(path.join(srcDir, 'main.rb'), path.join(d.plugins, SU_DIR, 'main.rb'));
      installed.push({ sketchup: d.version, series: pick, version: suPluginVersionOf(dstLoader), dir: dstLoader });
    } catch (e: any) {
      failed.push({ sketchup: d.version, error: String(e?.message || e) });
    }
  }
  return { ok: installed.length > 0, installed, failed, series, dirs: dirs.map(d => d.plugins) };
}

/** 面板用：装到哪些 SketchUp、版本是否与安装包一致 */
export function suInstallInfo(appRoot: string) {
  const series = suSeries(appRoot);
  const dirs = suUserDirs();
  const installedAt: string[] = [];
  for (const d of dirs) {
    const dst = path.join(d.plugins, SU_LOADER);
    if (!fs.existsSync(dst)) continue;
    const pick = pickSuSeries(series, d.version);
    const src = pick ? path.join(appRoot, 'bridge', 'su', pick, SU_LOADER) : '';
    let same = false;
    try { same = !!src && fs.readFileSync(src, 'utf8') === fs.readFileSync(dst, 'utf8'); } catch { /* ignore */ }
    installedAt.push(dst + (same ? '' : ' (版本不同)'));
  }
  return { series, dirs: dirs.map(d => d.plugins), installedAt, installed: installedAt.length > 0 };
}

// ---------------------------------------------------------------- 3ds Max 安装

const SCRIPT_BASE = 'AssetManagerBridge';

/** 安装到 Max 的文件名：AssetManagerBridge_0.2.0.ms（便于多个版本共存与识别） */
export function maxPluginFileName(): string {
  return `${SCRIPT_BASE}_${BRIDGE_SCRIPT_VERSION}.ms`;
}

/** 目录里已存在的本插件文件名（新版带版本号，旧版不带） */
function maxInstalledFile(dir: string): string {
  let ents: string[] = [];
  try { ents = fs.readdirSync(dir); } catch { return ''; }
  const re = new RegExp('^' + SCRIPT_BASE + '.*\\.ms$', 'i');
  const hits = ents.filter(f => re.test(f));
  if (!hits.length) return '';
  const versioned = maxPluginFileName();
  return hits.includes(versioned) ? versioned : hits.sort().reverse()[0];
}

/** 安装包里有哪些 3ds Max 系列目录（2026 / 2027 …，升序） */

/** Max 会把脚本里的 macroScript 持久化到 <语言>\usermacros\<类别>-<宏名>.mcr，
 *  插件删了这份文件还在，启动时会去调已不存在的函数 → 报「类型错误…undefined」。
 *  安装/卸载都要清掉它（安装时清掉是为了让 Max 用新脚本重新生成）。 */
function maxUsermacrosDir(startupDir: string): string {
  // …\3dsMax\2027 - 64bit\CHS\scripts\startup → …\CHS\usermacros
  const langDir = path.dirname(path.dirname(startupDir));
  return path.join(langDir, 'usermacros');
}

function removeMaxMacroFiles(startupDir: string): string[] {
  const out: string[] = [];
  const dir = maxUsermacrosDir(startupDir);
  let ents: string[] = [];
  try { ents = fs.readdirSync(dir); } catch { return out; }
  for (const f of ents) {
    if (!/\.mcr$/i.test(f)) continue;
    if (!/assetmanager/i.test(f)) continue;
    try { fs.unlinkSync(path.join(dir, f)); out.push(path.join(dir, f)); } catch { /* ignore */ }
  }
  return out;
}

export function maxSeries(appRoot: string): string[] {
  const dir = path.join(appRoot, 'bridge', 'max');
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => Number(a) - Number(b));
}

/** 给某个 Max 版本挑系列：必须「同版本」或「不高于该版本的最新系列」；
 *  比所有已有系列都老的目标（例如本机 2025 配置而只有 2026/2027 系列）返回 ''，
 *  由上层提示「没有适用于该版本的插件」，避免把不匹配的脚本塞进去。 */
export function pickMaxSeries(series: string[], maxYear: string): string | null {
  if (!series.length || !maxYear) return null;
  if (series.includes(maxYear)) return maxYear;
  const le = series.filter(s => Number(s) <= Number(maxYear));
  if (le.length) return le[le.length - 1];
  return '';
}

/** 某个 Max 系列脚本的路径；不传系列时取最新系列（面板上「插件来源」显示用） */
export function bridgeScriptPath(appRoot: string, series?: string) {
  const all = maxSeries(appRoot);
  const pick = series && all.includes(series) ? series : (all[all.length - 1] || '');
  const base = pick ? path.join(appRoot, 'bridge', 'max', pick) : path.join(appRoot, 'bridge', 'max');
  const versioned = path.join(base, maxPluginFileName());
  if (fs.existsSync(versioned)) return versioned;
  const legacy = path.join(base, `${SCRIPT_BASE}.ms`);   // 兼容旧布局 / 旧安装包
  if (fs.existsSync(legacy)) return legacy;
  return versioned;
}

export function readBridgeScript(appRoot: string, series?: string): string | null {
  try { return fs.readFileSync(bridgeScriptPath(appRoot, series), 'utf8'); } catch { return null; }
}

/** 从 startup 路径里取 Max 年份（…\3dsMax\2027 - 64bit\CHS\scripts\startup → 2027） */
export function maxYearOfStartupDir(dir: string): string {
  const m = String(dir).match(/3dsMax[\\/](\d{4})/i);
  return m ? m[1] : '';
}

/** 已存在的 3ds Max 用户配置目录下的 startup 目录 */
export function maxStartupDirs(): string[] {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(local, 'Autodesk', '3dsMax');
  const out: string[] = [];
  let versions: fs.Dirent[] = [];
  try { versions = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const v of versions) {
    if (!v.isDirectory()) continue;
    const vDir = path.join(base, v.name);
    let langs: fs.Dirent[] = [];
    try { langs = fs.readdirSync(vDir, { withFileTypes: true }); } catch { continue; }
    for (const l of langs) {
      if (!l.isDirectory()) continue;
      const lDir = path.join(vDir, l.name);
      // 只认真实存在的 Max 配置（会带 scripts 目录），避免给没装的版本造目录
      if (!fs.existsSync(path.join(lDir, 'scripts'))) continue;
      out.push(path.join(lDir, 'scripts', 'startup'));
    }
  }
  return out;
}

/** 一键装进本机所有 3ds Max 用户目录（按各自的 Max 版本挑对应系列） */
export function installForMax(appRoot: string) {
  const series = maxSeries(appRoot);
  if (!series.length) return { ok: false, error: '找不到 bridge/max/<Max 版本>/AssetManagerBridge_<插件版本>.ms（安装包缺少 bridge 目录）' };
  const dirs = maxStartupDirs();
  if (!dirs.length) return { ok: false, error: '没有找到 3ds Max 的用户配置目录（%LOCALAPPDATA%\\Autodesk\\3dsMax），请先启动一次 3ds Max' };
  const installed: string[] = [];
  const detail: { dir: string; year: string; series: string }[] = [];
  const failed: { dir: string; error: string }[] = [];
  for (const d of dirs) {
    const year = maxYearOfStartupDir(d);
    const pick = pickMaxSeries(series, year);
    if (!pick) { failed.push({ dir: d, error: `没有适用于 3ds Max ${year} 的插件系列（本机只有 ${series.join(' / ')}）` }); continue; }
    const src = readBridgeScript(appRoot, pick);
    if (!src) { failed.push({ dir: d, error: `读不到 bridge/max/${pick}/${maxPluginFileName()}` }); continue; }
    try {
      fs.mkdirSync(d, { recursive: true });
      // 清掉该目录里其它版本的插件文件，避免 Max 同时加载两份
      const dst = path.join(d, maxPluginFileName());
      try {
        for (const f of fs.readdirSync(d)) {
          if (/^AssetManagerBridge.*\.ms$/i.test(f) && f !== path.basename(dst)) fs.unlinkSync(path.join(d, f));
        }
      } catch { /* ignore */ }
      fs.writeFileSync(dst, src, 'utf8');
      removeMaxMacroFiles(d);           // 让 Max 下次启动用新脚本重新注册宏（旧宏体可能引用已改名的函数）
      installed.push(dst);
      detail.push({ dir: d, year, series: pick });
    } catch (e: any) {
      failed.push({ dir: d, error: String(e?.message || e) });
    }
  }
  return { ok: installed.length > 0, installed, detail, failed, dirs, series, version: BRIDGE_SCRIPT_VERSION };
}

/** 面板用：脚本是否存在、已装到哪些 Max、startup 目录（按各版本挑系列比对） */
export function installInfo(appRoot: string) {
  const series = maxSeries(appRoot);
  const newest = series[series.length - 1] || '';
  const script = newest ? bridgeScriptPath(appRoot, newest) : '';
  const exists = !!script && fs.existsSync(script);
  const dirs = maxStartupDirs();
  const installedAt: string[] = [];
  for (const d of dirs) {
    const name = maxInstalledFile(d);
    if (!name) continue;
    const p = path.join(d, name);
    const pick = pickMaxSeries(series, maxYearOfStartupDir(d));
    const src = pick ? readBridgeScript(appRoot, pick) : null;
    let same = false;
    try { same = !!src && fs.readFileSync(p, 'utf8') === src; } catch { /* ignore */ }
    installedAt.push(p + (same ? '' : ' (版本不同)'));
  }
  return {
    script: exists ? script : null,
    scriptVersion: BRIDGE_SCRIPT_VERSION,
    series,
    startupDirs: dirs,
    installedAt,
    installed: installedAt.length > 0
  };
}

// ---------------------------------------------------------------- Unreal Engine 安装

const UE_PLUGIN_DIR = 'AssetManagerBridge';

/** 安装包里有哪些 UE 系列目录（5.7 / 5.6 …） */
export function ueSeries(appRoot: string): string[] {
  const dir = path.join(appRoot, 'bridge', 'ue');
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && /^\d+\.\d+$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      return (pa[0] - pb[0]) || (pa[1] - pb[1]);
    });
}

/** 给某个 UE 版本挑系列：优先同版本，其次不超过它的最高系列，最后退回最低的 */
export function pickUeSeries(series: string[], ueVersion: string): string | null {
  if (!series.length) return null;
  if (series.includes(ueVersion)) return ueVersion;
  const [maj, min] = ueVersion.split('.').map(Number);
  const le = series.filter(s => {
    const [a, b] = s.split('.').map(Number);
    return a < maj || (a === maj && b <= min);
  });
  if (le.length) return le[le.length - 1];
  return series[0];
}

export interface UeProject {
  /** .uproject 绝对路径 */
  file: string;
  /** 工程名（不带扩展名） */
  name: string;
  /** .uproject 里的 EngineAssociation（"5.7" 或源码版 GUID） */
  engine: string;
  /** 工程 Plugins 目录 */
  pluginsDir: string;
}

/** UE 最近打开过的工程列表（%LOCALAPPDATA%\UnrealEngine\<ver>\Saved\Config\WindowsEditor\EditorSettings.ini） */
function ueRecentProjects(): string[] {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(local, 'UnrealEngine');
  let versions: fs.Dirent[] = [];
  try { versions = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const v of versions) {
    if (!v.isDirectory()) continue;
    for (const sub of ['WindowsEditor', 'Windows']) {
      const ini = path.join(base, v.name, 'Saved', 'Config', sub, 'EditorSettings.ini');
      let txt = '';
      try { txt = fs.readFileSync(ini, 'utf8'); } catch { continue; }
      for (const line of txt.split(/\r?\n/)) {
        // RecentlyOpenedProjectFiles=(ProjectName="D:/X/Y/Y.uproject",LastOpenTime=...)
        const m = line.match(/RecentlyOpenedProjectFiles=\(ProjectName="([^"]+\.uproject)"/i);
        if (m && !out.includes(m[1])) out.push(m[1]);
      }
    }
  }
  return out;
}

/** 本机存在过的 UE 工程（按最近打开排序，去重） */
export function ueProjects(): UeProject[] {
  const out: UeProject[] = [];
  const seen = new Set<string>();
  for (const f of ueRecentProjects()) {
    const norm = path.resolve(f);
    if (seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    if (!fs.existsSync(norm)) continue;
    let engine = '';
    try {
      const j = JSON.parse(fs.readFileSync(norm, 'utf8'));
      engine = String(j.EngineAssociation || '');
    } catch { continue; }
    out.push({
      file: norm,
      name: path.basename(norm, '.uproject'),
      engine,
      pluginsDir: path.join(path.dirname(norm), 'Plugins')
    });
  }
  return out;
}

function uePluginVersionOf(file: string): string {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(j.VersionName || '');
  } catch { return ''; }
}

/**
 * 在 .uproject 里启用插件（保留原有缩进与顺序，只在缺失时追加）。
 * 需要 PythonScriptPlugin 才会执行插件的 init_unreal.py。
 */export function enableUePlugins(projectFile: string, names: string[]): { ok: boolean; added: string[]; error?: string } {
  let raw = '';
  try { raw = fs.readFileSync(projectFile, 'utf8'); } catch (e: any) {
    return { ok: false, added: [], error: String(e?.message || e) };
  }
  let j: any;
  try { j = JSON.parse(raw); } catch (e: any) {
    return { ok: false, added: [], error: '解析 .uproject 失败：' + String(e?.message || e) };
  }
  const list: any[] = Array.isArray(j.Plugins) ? j.Plugins : [];
  const added: string[] = [];
  for (const name of names) {
    const hit = list.find(p => String(p?.Name).toLowerCase() === name.toLowerCase());
    if (hit) {
      if (hit.Enabled === false) { hit.Enabled = true; added.push(name + '(启用)'); }
      continue;
    }
    list.push({ Name: name, Enabled: true });
    added.push(name);
  }
  if (!added.length) return { ok: true, added };
  j.Plugins = list;
  // 用 tab 缩进写回（UE 自己也是这么存的）；只动 Plugins 字段，其它字段原样保留
  try {
    fs.writeFileSync(projectFile, JSON.stringify(j, null, '\t') + '\n', 'utf8');
  } catch (e: any) {
    return { ok: false, added: [], error: String(e?.message || e) };
  }
  return { ok: true, added };
}

/**
 * 从 .uproject 里移除插件条目（卸载用；只动传进来的名字，别的插件一行不改）
 */
export function disableUePlugins(projectFile: string, names: string[]): { ok: boolean; removed: string[]; error?: string } {
  let raw = '';
  try { raw = fs.readFileSync(projectFile, 'utf8'); } catch (e: any) {
    return { ok: false, removed: [], error: String(e?.message || e) };
  }
  let j: any;
  try { j = JSON.parse(raw); } catch (e: any) {
    return { ok: false, removed: [], error: '解析 .uproject 失败：' + String(e?.message || e) };
  }
  const list: any[] = Array.isArray(j.Plugins) ? j.Plugins : [];
  const lower = names.map(n => n.toLowerCase());
  const kept: any[] = [];
  const removed: string[] = [];
  for (const p of list) {
    const nm = String(p?.Name || '');
    if (lower.includes(nm.toLowerCase())) { removed.push(nm); continue; }
    kept.push(p);
  }
  if (!removed.length) return { ok: true, removed };
  j.Plugins = kept;
  try {
    fs.writeFileSync(projectFile, JSON.stringify(j, null, '\t') + '\n', 'utf8');
  } catch (e: any) {
    return { ok: false, removed: [], error: String(e?.message || e) };
  }
  return { ok: true, removed };
}

/** 手动挑过的 UE 工程（不在「最近打开」列表里的也能一直勾选/卸载）：存数据目录 ue-projects.json */
function ueExtraFile(dataDir: string) { return path.join(dataDir, 'ue-projects.json'); }

export function ueExtraProjects(dataDir: string): string[] {
  if (!dataDir) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(ueExtraFile(dataDir), 'utf8'));
    return Array.isArray(arr) ? arr.map(String).filter(f => fs.existsSync(f)) : [];
  } catch { return []; }
}

/** 记住手动选的工程（返回去重后的完整列表） */
export function addUeExtraProjects(dataDir: string, files: string[]): string[] {
  if (!dataDir) return [];
  const next = ueExtraProjects(dataDir);
  for (const f of files || []) {
    const p = ueProjectFromFile(f);
    if (!p) continue;
    if (!next.some(x => x.toLowerCase() === p.file.toLowerCase())) next.push(p.file);
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(ueExtraFile(dataDir), JSON.stringify(next, null, 2), 'utf8');
  } catch { /* ignore */ }
  return next;
}

/**
 * 递归复制目录（打包版 src 在 app.asar 里：asar 的 fs 垫片不支持 cpSync/lstat 目录，
 * 只能 readdirSync + copyFileSync 逐个来）
 */
function copyTreeSafe(src: string, dst: string, skip: Set<string> = new Set()) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  fs.mkdirSync(dst, { recursive: true });
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTreeSafe(from, to, skip);
    else if (e.isFile()) {
      try { fs.copyFileSync(from, to); } catch { /* ignore */ }
    }
  }
}

/** 从 .uproject 路径读一个工程条目（手动选工程时用，不要求在「最近打开」列表里） */
export function ueProjectFromFile(file: string): UeProject | null {
  const norm = path.resolve(String(file || ''));
  if (!norm.toLowerCase().endsWith('.uproject') || !fs.existsSync(norm)) return null;
  let engine = '';
  try {
    engine = String(JSON.parse(fs.readFileSync(norm, 'utf8')).EngineAssociation || '');
  } catch {
    return null;   // 不是合法 JSON 就不是工程文件
  }
  return {
    file: norm,
    name: path.basename(norm, '.uproject'),
    engine,
    pluginsDir: path.join(path.dirname(norm), 'Plugins')
  };
}

/** 把 UE 插件装进**指定的** UE 工程（按各工程引擎版本挑系列）
 *
 * projects：要安装的 .uproject 绝对路径（用户手动选/勾选的），必填。
 * 不再默认装到本机所有最近工程——那样会悄悄改动一堆别人的工程。
 */
export function installForUe(appRoot: string, projects: string[]) {
  const series = ueSeries(appRoot);
  if (!series.length) {
    return { ok: false, error: '安装包缺少 bridge/ue/<UE 版本>/ 目录（重新打包）' };
  }
  const wanted = (projects || []).map(f => ueProjectFromFile(f)).filter(Boolean) as UeProject[];
  const bad = (projects || []).filter((f, i) => !wanted[i]);
  if (!wanted.length) {
    return { ok: false, error: '没有可用的 .uproject（选中的文件不存在或不是 UE 工程）', series };
  }

  const installed: { project: string; engine: string; series: string; version: string; dir: string }[] = [];
  const failed: { project: string; error: string }[] = [];
  for (const p of wanted) {
    const pick = pickUeSeries(series, p.engine || series[series.length - 1]);
    const src = path.join(appRoot, 'bridge', 'ue', pick || '', UE_PLUGIN_DIR);
    if (!pick || !fs.existsSync(src)) {
      failed.push({ project: p.name, error: `缺少 bridge/ue/${pick}/${UE_PLUGIN_DIR}` });
      continue;
    }
    try {
      const dst = path.join(p.pluginsDir, UE_PLUGIN_DIR);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      copyTreeSafe(src, dst);
      if (!fs.existsSync(path.join(dst, UE_PLUGIN_DIR + '.uplugin'))) {
        throw new Error('插件文件没拷出来（安装包里的 bridge/ue 不完整）');
      }
      const en = enableUePlugins(p.file, [UE_PLUGIN_DIR, 'PythonScriptPlugin', 'EditorScriptingUtilities']);
      if (!en.ok) throw new Error(en.error || '启用插件失败');
      installed.push({
        project: p.name, engine: p.engine || '(未知)', series: pick,
        version: uePluginVersionOf(path.join(dst, UE_PLUGIN_DIR + '.uplugin')), dir: dst
      });
    } catch (e: any) {
      failed.push({ project: p.name, error: String(e?.message || e) });
    }
  }
  return {
    ok: installed.length > 0, installed, failed, series,
    projects: wanted.map(p => p.file),
    invalid: bad
  };
}

/** 面板用：本机最近打开的 UE 工程 + 每个工程是否已装插件、版本是否与安装包一致 */
export function ueInstallInfo(appRoot: string) {
  const series = ueSeries(appRoot);
  // 「是否最新」要比对真正的实现文件（只比 .uplugin 会把「代码变了但描述没变」当成最新）
  const implFile = (dir: string) => path.join(dir, 'Content', 'Python', 'assetmanager_ue.py');
  const items = ueProjects().map(p => {
    const dstDir = path.join(p.pluginsDir, UE_PLUGIN_DIR);
    const dst = path.join(dstDir, UE_PLUGIN_DIR + '.uplugin');
    const exists = fs.existsSync(dst);
    const pick = pickUeSeries(series, p.engine || series[series.length - 1]);
    const srcDir = pick ? path.join(appRoot, 'bridge', 'ue', pick, UE_PLUGIN_DIR) : '';
    let same = false;
    try {
      same = exists && !!srcDir
        && fs.readFileSync(implFile(srcDir), 'utf8') === fs.readFileSync(implFile(dstDir), 'utf8')
        && fs.readFileSync(path.join(srcDir, UE_PLUGIN_DIR + '.uplugin'), 'utf8')
          === fs.readFileSync(dst, 'utf8');
    } catch { /* 读不到就当不是最新 */ }
    return {
      name: p.name, file: p.file, engine: p.engine,
      installed: exists, version: exists ? uePluginVersionOf(dst) : '', upToDate: same
    };
  });
  return {
    series,
    projects: items.map(i => ({ name: i.name, file: i.file, engine: i.engine })),
    items,
    installedAt: items.filter(i => i.installed).map(i => i.file),
    installed: items.some(i => i.installed)
  };
}

// ---------------------------------------------------------------- Maya 安装

const MAYA_MODULE = 'AssetManagerBridge';
const MAYA_PY = path.join('scripts', 'assetmanager_maya.py');

/** 安装包里有哪些 Maya 系列目录（2025 / 2026 …） */
export function mayaSeries(appRoot: string): string[] {
  const dir = path.join(appRoot, 'bridge', 'maya');
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && /^\d{4}$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => Number(a) - Number(b));
}

/** 本机 Maya 的用户目录（%USERPROFILE%\Documents\maya\<年份>，里面才有 modules/ 或 prefs/） */
export function mayaUserDirs(): { version: string; modules: string }[] {
  const base0 = process.env.MAYA_APP_DIR
    || path.join(os.homedir(), 'Documents', 'maya');
  // Windows 的「文档」可能被重定向到 OneDrive，两处都看一眼
  const bases = [base0, path.join(os.homedir(), 'OneDrive', 'Documents', 'maya')];
  const out: { version: string; modules: string }[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !/^\d{4}$/.test(e.name)) continue;
      const vdir = path.join(base, e.name);
      const modules = path.join(vdir, 'modules');
      const used = fs.existsSync(modules) || fs.existsSync(path.join(vdir, 'prefs'))
        || fs.existsSync(path.join(vdir, 'Maya.env'));
      if (!used) continue;
      const key = (base + '|' + e.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ version: e.name, modules });
    }
  }
  return out.sort((a, b) => Number(a.version) - Number(b.version));
}

/** 给某个 Maya 版本挑系列：优先同年份，其次不超过它的最高系列，最后退回最低的 */
export function pickMayaSeries(series: string[], mayaVersion: string): string | null {
  if (!series.length) return null;
  if (series.includes(mayaVersion)) return mayaVersion;
  const le = series.filter(s => Number(s) <= Number(mayaVersion));
  if (le.length) return le[le.length - 1];
  return series[0];
}

function mayaPluginVersionOf(file: string): string {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/AM_PLUGIN_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : '';
  } catch { return ''; }
}

/**
 * 一键把 Maya 插件装进本机所有 Maya 用户目录：
 *   <Documents>\maya\<年份>\modules\AssetManagerBridge.mod      （模块声明，指向同目录下的插件文件夹）
 *   <Documents>\maya\<年份>\modules\AssetManagerBridge\scripts\  （userSetup.py + assetmanager_maya.py）
 * 只动用户目录，不碰 Maya 安装目录，也不改 Maya.env。
 */
export function installForMaya(appRoot: string) {
  const series = mayaSeries(appRoot);
  if (!series.length) {
    return { ok: false, error: '安装包缺少 bridge/maya/<Maya 版本>/ 目录（重新打包）' };
  }
  const dirs = mayaUserDirs();
  if (!dirs.length) {
    return {
      ok: false,
      error: '没找到 Maya 用户目录（%USERPROFILE%\\Documents\\maya\\20XX\\modules）：先启动一次 Maya 再装',
      series
    };
  }

  const installed: { maya: string; series: string; version: string; dir: string }[] = [];
  const failed: { maya: string; error: string }[] = [];
  for (const d of dirs) {
    const pick = pickMayaSeries(series, d.version);
    if (!pick) continue;
    const srcDir = path.join(appRoot, 'bridge', 'maya', pick);
    const srcMod = path.join(srcDir, MAYA_MODULE + '.mod');
    const srcPy = path.join(srcDir, MAYA_PY);
    if (!fs.existsSync(srcMod) || !fs.existsSync(srcPy)) {
      failed.push({ maya: d.version, error: `缺少 ${pick}/${MAYA_MODULE}.mod 或 ${MAYA_PY}` });
      continue;
    }
    try {
      const dstPlugin = path.join(d.modules, MAYA_MODULE);
      fs.mkdirSync(dstPlugin, { recursive: true });
      // 跳过 __pycache__（Maya 自己会在用户目录里重新生成）
      copyTreeSafe(path.join(srcDir, 'scripts'), path.join(dstPlugin, 'scripts'), new Set(['__pycache__']));
      // .mod 里的版本号跟插件版本走（.mod 的版本号只是显示用，Maya 不校验）
      const version = mayaPluginVersionOf(path.join(dstPlugin, MAYA_PY));
      const modText = fs.readFileSync(srcMod, 'utf8')
        .replace(/^(\+\s*\S+\s+)\S+/m, `$1${version || '0.1.0'}`);
      fs.writeFileSync(path.join(d.modules, MAYA_MODULE + '.mod'), modText, 'utf8');
      installed.push({
        maya: d.version, series: pick, version: mayaPluginVersionOf(path.join(dstPlugin, MAYA_PY)),
        dir: path.join(d.modules, MAYA_MODULE + '.mod')
      });
    } catch (e: any) {
      failed.push({ maya: d.version, error: String(e?.message || e) });
    }
  }
  return { ok: installed.length > 0, installed, failed, series, dirs: dirs.map(d => d.modules) };
}

/** 面板用：装到哪些 Maya、版本是否与安装包一致 */
export function mayaInstallInfo(appRoot: string) {
  const series = mayaSeries(appRoot);
  const dirs = mayaUserDirs();
  const items = dirs.map(d => {
    const modFile = path.join(d.modules, MAYA_MODULE + '.mod');
    const pyFile = path.join(d.modules, MAYA_MODULE, MAYA_PY);
    const exists = fs.existsSync(modFile) && fs.existsSync(pyFile);
    const pick = pickMayaSeries(series, d.version);
    const srcPy = pick ? path.join(appRoot, 'bridge', 'maya', pick, MAYA_PY) : '';
    let same = false;
    try {
      same = exists && !!srcPy && fs.readFileSync(srcPy, 'utf8') === fs.readFileSync(pyFile, 'utf8');
    } catch { /* 读不到就当不是最新 */ }
    return {
      maya: d.version, dir: modFile, installed: exists,
      version: exists ? mayaPluginVersionOf(pyFile) : '', upToDate: same
    };
  });
  return {
    series,
    dirs: dirs.map(d => d.modules),
    items,
    installedAt: items.filter(i => i.installed).map(i => i.dir + (i.upToDate ? '' : ' (版本不同)')),
    installed: items.some(i => i.installed)
  };
}

/**
 * 把当前服务端口写到固定位置，供 MaxScript 发现：
 * %LOCALAPPDATA%\AssetManager\bridge.json
 * （端口可能因占用从 8787 漂移，插件先读它再扫描 8787-8799）
 */
export function writeLocator(port: number, appRoot: string, version: string) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'AssetManager');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'bridge.json');
    fs.writeFileSync(file, JSON.stringify({
      app: 'AssetManager', protocol: BRIDGE_PROTOCOL, port, version,
      appRoot, scriptVersion: BRIDGE_SCRIPT_VERSION, at: Date.now()
    }, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 统一插件安装/卸载（按 DCC 版本）
//
// 「安装插件」弹窗用：列出本机每个 DCC 的每个版本，勾选=安装、取消=卸载。
// UE 是「按工程」安装的，不走这套（面板里单独有工程选择框）。

export type PluginDcc = 'max' | 'blender' | 'su' | 'maya' | 'ue';

export type PluginTarget = {
  dcc: PluginDcc;
  key: string;          // dcc + 版本（UE 是工程路径），前端勾选状态用
  label: string;        // 3ds Max 2027（CHS）／UE 工程名（UE 5.7）
  dir: string;          // 安装目录（给人看）
  series: string;       // 用的插件系列（2027 / 5.2 / 2026 / 2025 / 5.7）
  pluginVersion: string;// 源码里的插件版本
  installed: boolean;
  upToDate: boolean;    // 已装且与源码一致
};

function readVer(file: string, re: RegExp): string {
  try { return (fs.readFileSync(file, 'utf8').match(re) || [])[1] || ''; } catch { return ''; }
}

/** 本机所有可安装的「DCC + 版本」目标（UE 按工程算，一行一个工程） */
export function pluginTargets(appRoot: string, dataDir = ''): PluginTarget[] {
  const out: PluginTarget[] = [];

  // --- 3ds Max ---
  const mxSeries = maxSeries(appRoot);
  for (const dir of maxStartupDirs()) {
    const year = maxYearOfStartupDir(dir);
    // 严格按目标版本挑系列：pick === '' 表示「没有适用于该 Max 版本的插件」
    const pick = pickMaxSeries(mxSeries, year) || '';
    const src = pick ? readBridgeScript(appRoot, pick) : null;
    const name = maxInstalledFile(dir);
    let same = false;
    try { same = !!src && !!name && fs.readFileSync(path.join(dir, name), 'utf8') === src; } catch { /* ignore */ }
    const lang = (dir.match(/\\([A-Z]{3})\\scripts\\/i) || [])[1] || '';
    out.push({
      dcc: 'max',
      key: `max:${year}:${lang}`,
      label: `3ds Max ${year}${lang ? `（${lang}）` : ''}`,
      dir,
      series: pick,
      pluginVersion: BRIDGE_SCRIPT_VERSION,
      installed: !!name,
      upToDate: same
    });
  }

  // --- Blender ---
  const blSeries = blenderSeries(appRoot);
  for (const d of blenderUserDirs()) {
    const pick = pickBlenderSeries(blSeries, d.version) || '';
    const srcFile = pick ? path.join(appRoot, 'bridge', 'blender', pick, BLENDER_PLUGIN_FILE) : '';
    const dst = path.join(d.addons, BLENDER_PLUGIN_FILE);
    const has = fs.existsSync(dst);
    let same = false;
    try { same = has && fs.readFileSync(dst, 'utf8') === fs.readFileSync(srcFile, 'utf8'); } catch { /* ignore */ }
    out.push({
      dcc: 'blender',
      key: `blender:${d.version}`,
      label: `Blender ${d.version}`,
      dir: d.addons,
      series: pick,
      pluginVersion: readVer(has ? dst : srcFile, /(?:BL_VERSION|AM_PLUGIN_VERSION)\s*=\s*['"]([^'"]+)['"]/),
      installed: has,
      upToDate: same
    });
  }

  // --- SketchUp ---
  const suSeriesAll = suSeries(appRoot);
  for (const d of suUserDirs()) {
    const pick = pickSuSeries(suSeriesAll, d.version) || '';
    const srcLoader = pick ? path.join(appRoot, 'bridge', 'su', pick, SU_LOADER) : '';
    const dst = path.join(d.plugins, SU_LOADER);
    const has = fs.existsSync(dst);
    let same = false;
    try {
      same = has && fs.readFileSync(dst, 'utf8') === fs.readFileSync(srcLoader, 'utf8')
        && fs.readFileSync(path.join(d.plugins, SU_DIR, 'main.rb'), 'utf8')
           === fs.readFileSync(path.join(appRoot, 'bridge', 'su', pick, SU_DIR, 'main.rb'), 'utf8');
    } catch { /* ignore */ }
    out.push({
      dcc: 'su',
      key: `su:${d.version}`,
      label: `SketchUp ${d.version}`,
      dir: d.plugins,
      series: pick,
      pluginVersion: has ? readVer(dst, /AM_PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/) : readVer(srcLoader, /AM_PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/),
      installed: has,
      upToDate: same
    });
  }

  // --- Maya ---
  const mySeries = mayaSeries(appRoot);
  for (const d of mayaUserDirs()) {
    const pick = pickMayaSeries(mySeries, d.version) || '';
    const dstMod = path.join(d.modules, MAYA_MODULE + '.mod');
    const has = fs.existsSync(dstMod);
    let same = false;
    try {
      // .mod 是安装时按版本生成的，只比对插件本体（.mod 内部内容由生成逻辑保证）
      same = has && fs.readFileSync(path.join(d.modules, MAYA_MODULE, MAYA_PY), 'utf8')
        === fs.readFileSync(path.join(appRoot, 'bridge', 'maya', pick, MAYA_PY), 'utf8');
    } catch { /* ignore */ }
    out.push({
      dcc: 'maya',
      key: `maya:${d.version}`,
      label: `Maya ${d.version}`,
      dir: d.modules,
      series: pick,
      pluginVersion: has ? readVer(dstMod, /AssetManagerBridge\s+([0-9.]+)/) : readVer(path.join(appRoot, 'bridge', 'maya', pick, MAYA_MODULE + '.mod'), /AssetManagerBridge\s+([0-9.]+)/),
      installed: has,
      upToDate: same
    });
  }

  // --- Unreal Engine（按工程：一行一个工程，勾选=装进该工程、取消=从该工程移除） ---
  const ueSeriesAll = ueSeries(appRoot);
  const ueSeen = new Set<string>();
  const ueProjList: UeProject[] = [];
  for (const p of ueProjects()) { ueProjList.push(p); ueSeen.add(p.file.toLowerCase()); }
  for (const f of ueExtraProjects(dataDir)) {
    if (ueSeen.has(f.toLowerCase())) continue;
    const p = ueProjectFromFile(f);
    if (p) { ueProjList.push(p); ueSeen.add(p.file.toLowerCase()); }
  }
  for (const p of ueProjList) {
    const fallback = ueSeriesAll[ueSeriesAll.length - 1] || '';
    const pick = pickUeSeries(ueSeriesAll, p.engine || fallback) || '';
    const srcDir = pick ? path.join(appRoot, 'bridge', 'ue', pick, UE_PLUGIN_DIR) : '';
    const dstDir = path.join(p.pluginsDir, UE_PLUGIN_DIR);
    const uplugin = UE_PLUGIN_DIR + '.uplugin';
    const has = fs.existsSync(path.join(dstDir, uplugin));
    let same = false;
    try {
      same = has && !!srcDir
        && fs.readFileSync(path.join(srcDir, 'Content', 'Python', 'assetmanager_ue.py'), 'utf8')
           === fs.readFileSync(path.join(dstDir, 'Content', 'Python', 'assetmanager_ue.py'), 'utf8')
        && fs.readFileSync(path.join(srcDir, uplugin), 'utf8')
           === fs.readFileSync(path.join(dstDir, uplugin), 'utf8');
    } catch { /* 读不到就当不是最新 */ }
    out.push({
      dcc: 'ue',
      key: `ue:${p.file}`,
      label: `${p.name}（${p.engine ? 'UE ' + p.engine : 'UE 版本未知'}）`,
      dir: dstDir,
      series: pick,
      pluginVersion: uePluginVersionOf(has ? path.join(dstDir, uplugin) : (srcDir ? path.join(srcDir, uplugin) : '')),
      installed: has,
      upToDate: same
    });
  }

  return out.sort((a, b) => (a.dcc === b.dcc ? a.label.localeCompare(b.label) : a.dcc.localeCompare(b.dcc)));
}

/** 安装 / 卸载某个具体目标（key 来自 pluginTargets） */
export function applyPluginTarget(
  appRoot: string, key: string, install: boolean, dataDir = ''
): { ok: boolean; error?: string; file?: string; note?: string } {
  const t = pluginTargets(appRoot, dataDir).find(x => x.key === key);
  if (!t) return { ok: false, error: '目标不存在（可能已卸载 DCC 或重启过）' };

  try {
    if (t.dcc === 'max') {
      if (install && !t.series) {
        return { ok: false, error: `没有适用于 ${t.label} 的插件系列（应用里只有 bridge/max/${maxSeries(appRoot).join('、') || '（空）'}）` };
      }
      if (install) {
        const src = readBridgeScript(appRoot, t.series);
        if (!src) return { ok: false, error: `读不到系列 ${t.series} 的脚本` };
        fs.mkdirSync(t.dir, { recursive: true });
        const dst = path.join(t.dir, maxPluginFileName());
        for (const f of fs.readdirSync(t.dir)) {
          if (/^AssetManagerBridge.*\.ms$/i.test(f) && f !== path.basename(dst)) fs.unlinkSync(path.join(t.dir, f));
        }
        fs.writeFileSync(dst, src, 'utf8');
        removeMaxMacroFiles(t.dir);      // 让 Max 用新脚本重新生成宏（旧宏体可能已过时）
        return { ok: true, file: dst };
      }
      let removed = 0;
      for (const f of fs.readdirSync(t.dir)) {
        if (/^AssetManagerBridge.*\.ms$/i.test(f)) { fs.unlinkSync(path.join(t.dir, f)); removed++; }
      }
      // 关键：清掉 usermacros 里由插件注册的宏，否则 Max 启动会报
      // 「MAXScript MacroScript 错误…类型错误: 调用需要函数或类，得到的是: undefined」
      const macros = removeMaxMacroFiles(t.dir);
      removed += macros.length;
      return removed
        ? { ok: true, note: macros.length ? `已同时清理残留宏 ${macros.length} 个` : '' }
        : { ok: false, error: '这个 Max 目录里没有插件文件' };
    }

    if (t.dcc === 'blender') {
      const dst = path.join(t.dir, BLENDER_PLUGIN_FILE);
      if (install) {
        const src = path.join(appRoot, 'bridge', 'blender', t.series, BLENDER_PLUGIN_FILE);
        if (!fs.existsSync(src)) return { ok: false, error: `缺少 ${t.series}/${BLENDER_PLUGIN_FILE}` };
        fs.mkdirSync(t.dir, { recursive: true });
        fs.copyFileSync(src, dst);
        try { fs.rmSync(path.join(t.dir, '__pycache__'), { recursive: true, force: true }); } catch { /* ignore */ }
        return { ok: true, file: dst };
      }
      if (!fs.existsSync(dst)) return { ok: false, error: '没有安装记录' };
      fs.unlinkSync(dst);
      try { fs.rmSync(path.join(t.dir, '__pycache__'), { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: true };
    }

    if (t.dcc === 'su') {
      const dstLoader = path.join(t.dir, SU_LOADER);
      const dstDir = path.join(t.dir, SU_DIR);
      if (install) {
        const srcLoader = path.join(appRoot, 'bridge', 'su', t.series, SU_LOADER);
        const srcMain = path.join(appRoot, 'bridge', 'su', t.series, SU_DIR, 'main.rb');
        if (!fs.existsSync(srcLoader) || !fs.existsSync(srcMain)) return { ok: false, error: `缺少 ${t.series}/${SU_LOADER} 或 ${SU_DIR}/main.rb` };
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(srcLoader, dstLoader);
        fs.copyFileSync(srcMain, path.join(dstDir, 'main.rb'));
        return { ok: true, file: dstLoader };
      }
      let removed = 0;
      try { if (fs.existsSync(dstLoader)) { fs.unlinkSync(dstLoader); removed++; } } catch { /* ignore */ }
      try { if (fs.existsSync(dstDir)) { fs.rmSync(dstDir, { recursive: true, force: true }); removed++; } } catch { /* ignore */ }
      return removed ? { ok: true } : { ok: false, error: '没有安装记录' };
    }

    if (t.dcc === 'ue') {
      // key = `ue:<.uproject 绝对路径>`
      const p = ueProjectFromFile(t.key.slice(3));
      if (!p) return { ok: false, error: '这个工程文件已不存在（被移动或删除了？）' };
      const dst = path.join(p.pluginsDir, UE_PLUGIN_DIR);
      const uplugin = UE_PLUGIN_DIR + '.uplugin';
      if (install) {
        if (!t.series) return { ok: false, error: `没有适用于 UE ${p.engine || '(未知版本)'} 的插件系列` };
        const src = path.join(appRoot, 'bridge', 'ue', t.series, UE_PLUGIN_DIR);
        if (!fs.existsSync(src)) return { ok: false, error: `缺少 bridge/ue/${t.series}/${UE_PLUGIN_DIR}` };
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        copyTreeSafe(src, dst);
        if (!fs.existsSync(path.join(dst, uplugin))) {
          return { ok: false, error: '插件文件没拷出来（安装包里的 bridge/ue 不完整）' };
        }
        const en = enableUePlugins(p.file, [UE_PLUGIN_DIR, 'PythonScriptPlugin', 'EditorScriptingUtilities']);
        if (!en.ok) return { ok: false, error: en.error || '启用插件失败' };
        return { ok: true, file: path.join(dst, uplugin) };
      }
      let removed = 0;
      try { if (fs.existsSync(dst)) { fs.rmSync(dst, { recursive: true, force: true }); removed++; } } catch { /* ignore */ }
      const dis = disableUePlugins(p.file, [UE_PLUGIN_DIR]);
      if (removed || dis.removed.length) return { ok: true };
      return { ok: false, error: '这个工程里没有装插件' };
    }

    // maya
    const dstMod = path.join(t.dir, MAYA_MODULE + '.mod');
    const dstDir = path.join(t.dir, MAYA_MODULE);
    if (install) {
      const srcMod = path.join(appRoot, 'bridge', 'maya', t.series, MAYA_MODULE + '.mod');
      const srcPy = path.join(appRoot, 'bridge', 'maya', t.series, MAYA_PY);
      if (!fs.existsSync(srcMod) || !fs.existsSync(srcPy)) return { ok: false, error: `缺少 ${t.series}/${MAYA_MODULE}.mod 或 ${MAYA_PY}` };
      fs.mkdirSync(path.join(dstDir, 'scripts'), { recursive: true });
      fs.copyFileSync(srcMod, dstMod);
      fs.copyFileSync(srcPy, path.join(dstDir, MAYA_PY));
      return { ok: true, file: dstMod };
    }
    let removed = 0;
    try { if (fs.existsSync(dstMod)) { fs.unlinkSync(dstMod); removed++; } } catch { /* ignore */ }
    try { if (fs.existsSync(dstDir)) { fs.rmSync(dstDir, { recursive: true, force: true }); removed++; } } catch { /* ignore */ }
    return removed ? { ok: true } : { ok: false, error: '没有安装记录' };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
