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
import type { DB } from './db.ts';

/** 插件协议版本（服务端 + .ms 一起改） */
export const BRIDGE_PROTOCOL = 1;
/** 插件脚本版本（面板显示；与应用版本保持一致，第三位递增） */
export const BRIDGE_SCRIPT_VERSION = '0.1.12';

const LEASE_MS = 90_000;
const CONNECTED_MS = 6000;
const DEDUPE_MS = 30_000;

export type BridgeTarget = 'max' | 'su' | 'blender' | 'houdini' | 'ue';

export const TARGET_LABEL: Record<string, string> = {
  max: '3ds Max',
  su: 'SketchUp',
  blender: 'Blender',
  houdini: 'Houdini',
  ue: 'Unreal Engine'
};

export const MODE_LABEL: Record<string, string> = {
  import: '导入模型',
  material: '创建材质',
  texture: '发送贴图'
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
    const byExt = bundle.files.find(f => /\.(fbx|obj|glb|gltf|stl|3ds|abc|usdz|blend|max)$/i.test(f.rel_path));
    return byExt || null;
  }
  // 多 LOD / 多尺寸：优先 slot 01
  return models.find(f => f.slot === '01') || models[0];
}

/** 素材 → 任务载荷 */
export function buildPayload(db: DB, assetId: number, mode: string) {
  const bundle = loadBundle(db, assetId);
  if (!bundle) return { error: 'asset not found' as const };
  const a = bundle.asset;
  const spec = materialSpec(bundle);

  // F-007：模型/材质里手动指定的贴图覆盖，优先于自动匹配
  try {
    const key = `${a.rel_dir}|${a.name}|${a.type}`;
    const ovs = db.prepare('SELECT material, channel, file_rel FROM material_overrides WHERE asset_key=?').all(key) as any[];
    for (const r of ovs) {
      if (r.material !== spec.name && r.material !== a.name) continue;
      const ch = String(r.channel);
      const entry: MapEntry = {
        path: abs(bundle.root, r.file_rel),
        channel: (ch === 'baseColor' || ch === 'emissive' || ch === 'normal') ? 'rgb' : 'r',
        intensity: ch === 'height' ? 0.04 : 1
      };
      if (ch === 'normal') entry.normalSpace = 'gl';
      spec.maps[ch] = entry;
    }
  } catch { /* table may not exist on old DBs */ }

  const sourceDir = path.join(bundle.root, String(a.rel_dir));

  if (mode === 'import') {
    const m = modelFile(bundle);
    if (!m) return { error: '该素材没有可导入的模型文件' as const };
    return {
      payload: {
        assetId,
        name: String(a.name),
        sourceDir,
        modelPath: abs(bundle.root, m.rel_path),
        ext: path.extname(m.rel_path).toLowerCase(),
        material: spec,
        maps: mapsBySlot(spec)
      }
    };
  }

  if (mode === 'material') {
    if (!Object.keys(spec.maps).length) return { error: '该素材没有可用的贴图' as const };
    return { payload: { ...spec, assetId, assetName: String(a.name), sourceDir } };
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

  return { error: '未知模式' as const };
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

  const dir = path.join(os.tmpdir(), 'AssetManager', 'drops');
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
    `    -- 参数：id、代表文件、类型、源目录、名称、模型文件（源目录随文件一起带，避免插件认错素材）`,
    `    amb_drop_asset ${assetId} ${verbatim(primary)} ${JSON.stringify(kind)} ${verbatim(sourceDir)} ${verbatim(String(a.name))} ${verbatim(modelPath)}`,
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

export function sendJob(db: DB, assetId: number, target: string, mode: string) {
  const b = buildPayload(db, assetId, mode);
  if ('error' in b) return b;
  const now = Date.now();

  // 防重复点击：同一素材 + 模式在 30s 内已有排队/执行中的任务，直接复用
  const dup = db.prepare(`SELECT * FROM bridge_jobs
    WHERE target=? AND asset_id=? AND mode=? AND status IN ('pending','running') AND created_at > ?
    ORDER BY id DESC LIMIT 1`).get(target, assetId, mode, now - DEDUPE_MS) as any;
  if (dup) return { id: dup.id, reused: true, status: dup.status };

  const asset = db.prepare('SELECT name FROM assets WHERE id=?').get(assetId) as any;
  const title = `${asset?.name || '素材'} · ${MODE_LABEL[mode] || mode}`;
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

export function heartbeat(db: DB, target: string, version?: string, host?: string, info?: any) {
  const now = Date.now();
  db.prepare(`INSERT INTO bridge_clients(target,last_seen,version,host,info) VALUES(?,?,?,?,?)
    ON CONFLICT(target) DO UPDATE SET last_seen=excluded.last_seen, version=excluded.version,
      host=excluded.host, info=excluded.info`)
    .run(target, now, version || '', host || '', info ? JSON.stringify(info) : null);
  return { ok: true, at: now };
}

/** 轮询取任务时顺手刷新在线时间（心跳包丢了也不会误判离线） */
export function touchClient(db: DB, target: string) {
  try {
    db.prepare('UPDATE bridge_clients SET last_seen=? WHERE target=?').run(Date.now(), target);
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

// ---------------------------------------------------------------- 3ds Max 安装

const SCRIPT_NAME = 'AssetManagerBridge.ms';

export function bridgeScriptPath(appRoot: string) {
  return path.join(appRoot, 'bridge', 'max', SCRIPT_NAME);
}

export function readBridgeScript(appRoot: string): string | null {
  try { return fs.readFileSync(bridgeScriptPath(appRoot), 'utf8'); } catch { return null; }
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

export function installForMax(appRoot: string) {
  const src = readBridgeScript(appRoot);
  if (!src) return { ok: false, error: '找不到 bridge/max/AssetManagerBridge.ms（安装包缺少 bridge 目录）' };
  const dirs = maxStartupDirs();
  if (!dirs.length) return { ok: false, error: '没有找到 3ds Max 的用户配置目录（%LOCALAPPDATA%\\Autodesk\\3dsMax），请先启动一次 3ds Max' };
  const installed: string[] = [];
  const failed: { dir: string; error: string }[] = [];
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const dst = path.join(d, SCRIPT_NAME);
      fs.writeFileSync(dst, src, 'utf8');
      installed.push(dst);
    } catch (e: any) {
      failed.push({ dir: d, error: String(e?.message || e) });
    }
  }
  return { ok: installed.length > 0, installed, failed, dirs, version: BRIDGE_SCRIPT_VERSION };
}

/** 面板用：脚本是否存在、已装到哪些 Max、startup 目录 */
export function installInfo(appRoot: string) {
  const script = bridgeScriptPath(appRoot);
  const exists = fs.existsSync(script);
  const dirs = maxStartupDirs();
  const installedAt: string[] = [];
  for (const d of dirs) {
    const p = path.join(d, SCRIPT_NAME);
    if (fs.existsSync(p)) {
      let same = false;
      try { same = fs.readFileSync(p, 'utf8') === fs.readFileSync(script, 'utf8'); } catch { /* ignore */ }
      installedAt.push(p + (same ? '' : ' (版本不同)'));
    }
  }
  return {
    script: exists ? script : null,
    scriptVersion: BRIDGE_SCRIPT_VERSION,
    startupDirs: dirs,
    installedAt,
    installed: installedAt.length > 0
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
