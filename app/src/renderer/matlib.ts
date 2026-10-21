import * as THREE from 'three';
import type { AssetFile } from './types';

export type ChannelKey = 'baseColor' | 'roughness' | 'metallic' | 'normal' | 'ao' | 'height' | 'emissive' | 'opacity';

export interface UvCfg { u: number; v: number; rot: number }

export interface HslCfg { h: number; s: number; l: number }

export interface ChannelCfg {
  fileId?: number;
  channel?: 'rgb' | 'r' | 'g' | 'b' | 'a';
  intensity?: number;
  invert?: boolean;
  normalSpace?: 'gl' | 'dx';
  uv?: UvCfg;
  hsl?: HslCfg;
}

export interface MaterialConfig {
  workflow: 'MR' | 'SG';
  channels: Partial<Record<ChannelKey, ChannelCfg>>;
  /** 整材质 UV：平铺、旋转、位移对所有通道一起生效 */
  uv?: { repeatU: number; repeatV: number; rot: number; offsetU: number; offsetV: number };
}

export const CHANNELS: { key: ChannelKey; label: string; hint: string; optional?: boolean; scalar?: boolean; defChannel: 'rgb' | 'r' | 'g' | 'b' }[] = [
  { key: 'baseColor', label: 'Base Color', hint: '漫反射 / 颜色', defChannel: 'rgb' },
  { key: 'roughness', label: 'Roughness', hint: '粗糙度', scalar: true, defChannel: 'g' },
  { key: 'metallic', label: 'Metallic', hint: '金属度', scalar: true, defChannel: 'b' },
  { key: 'normal', label: 'Normal', hint: '法线', defChannel: 'rgb' },
  { key: 'ao', label: 'AO', hint: '环境光遮蔽', scalar: true, defChannel: 'r' },
  { key: 'height', label: 'Height', hint: '置换（可选）', optional: true, scalar: true, defChannel: 'r' },
  { key: 'emissive', label: 'Emissive', hint: '自发光（可选）', optional: true, defChannel: 'rgb' },
  { key: 'opacity', label: 'Opacity', hint: '不透明度（可选）', optional: true, scalar: true, defChannel: 'r' }
];

export function channelLabel(key: ChannelKey, workflow: 'MR' | 'SG') {
  if (key === 'roughness') return workflow === 'SG' ? 'Glossiness' : 'Roughness';
  if (key === 'metallic') return workflow === 'SG' ? 'Specular' : 'Metallic';
  return CHANNELS.find(c => c.key === key)?.label ?? key;
}

export function channelHint(key: ChannelKey, workflow: 'MR' | 'SG') {
  if (key === 'roughness') return workflow === 'SG' ? '光泽度（1 − 粗糙）' : '粗糙度';
  if (key === 'metallic') return workflow === 'SG' ? '镜面反射（近似）' : '金属度';
  return CHANNELS.find(c => c.key === key)?.hint ?? '';
}

const lc = (s: string) => s.toLowerCase();

function find(files: AssetFile[], ...keys: string[]) {
  for (const k of keys) {
    const hit = files.find(f => lc(f.rel_path).includes(k));
    if (hit) return hit;
  }
  return undefined;
}

export function detectConfig(files: AssetFile[], slotMap?: Record<string, string> | null): MaterialConfig {
  // 回写导出时插件会写 asset_maps.json（槽位→文件名），有它就直接用，别再按文件名猜
  if (slotMap && Object.keys(slotMap).length) {
    const byRel = new Map(files.map(f => [f.rel_path.toLowerCase(), f]));
    const cfg: MaterialConfig = { workflow: 'MR', channels: {} };
    const ch: Record<string, 'rgb' | 'r' | 'g' | 'b'> = { baseColor: 'rgb', normal: 'rgb', roughness: 'r', metallic: 'r', ao: 'r', height: 'r', emissive: 'rgb', opacity: 'r' };
    for (const [slot, rel] of Object.entries(slotMap)) {
      const f = byRel.get(String(rel).toLowerCase());
      if (!f) continue;
      const key = slot as ChannelKey;
      const entry: ChannelCfg = { fileId: f.id, channel: ch[slot] || 'rgb', intensity: 1 };
      if (slot === 'normal') entry.normalSpace = /(_dx|dx_|directx)/i.test(f.rel_path.toLowerCase()) ? 'dx' : 'gl';
      cfg.channels[key] = entry;
    }
    if (Object.keys(cfg.channels).length) return cfg;
  }
  const packed = find(files, '_arm_', '_orm_', '_omr_', '_rma_', '_arm.', '_orm.');
  const cfg: MaterialConfig = { workflow: 'MR', channels: {} };

  const base = find(files, 'basecolor', 'base_color', 'albedo', 'diffuse', '_diff', 'color');
  const normal = find(files, 'normal', 'nor_gl', 'nor_dx', '_nrm');
  const rough = find(files, 'roughness', 'rough');
  const metal = find(files, 'metallic', 'metal');
  const ao = find(files, '_ao', 'ambient', 'occlusion');
  const height = find(files, 'height', 'displacement', '_disp');

  if (base) cfg.channels.baseColor = { fileId: base.id, channel: 'rgb', intensity: 1 };
  if (normal) cfg.channels.normal = {
    fileId: normal.id, channel: 'rgb', intensity: 1,
    normalSpace: /(_dx|dx_|directx)/i.test(lc(normal.rel_path)) ? 'dx' : 'gl'
  };
  if (packed) {
    const p = lc(packed.rel_path);
    const isOmr = p.includes('_omr_');
    cfg.channels.ao = { fileId: packed.id, channel: 'r', intensity: 1 };
    cfg.channels.roughness = { fileId: packed.id, channel: isOmr ? 'b' : 'g', intensity: 1 };
    cfg.channels.metallic = { fileId: packed.id, channel: isOmr ? 'g' : 'b', intensity: 1 };
  } else {
    if (rough) cfg.channels.roughness = { fileId: rough.id, channel: 'g', intensity: 1 };
    if (metal) cfg.channels.metallic = { fileId: metal.id, channel: 'b', intensity: 1 };
    if (ao) cfg.channels.ao = { fileId: ao.id, channel: 'r', intensity: 1 };
  }
  if (height) cfg.channels.height = { fileId: height.id, channel: 'r', intensity: 1 };
  return cfg;
}

const texCache = new Map<string, Promise<THREE.Texture>>();
export function loadTexture(f: AssetFile, srgb = false): Promise<THREE.Texture> {
  const key = f.id + (srgb ? ':s' : ':l');
  let p = texCache.get(key);
  if (!p) {
    p = new Promise((res, rej) => {
      const src = /^[a-zA-Z]:[\\/]/.test(f.rel_path)
        ? `/api/path-file?path=${encodeURIComponent(f.rel_path)}`
        : `/api/file/${f.id}`;
      new THREE.TextureLoader().load(src, t => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        res(t);
      }, undefined, rej);
    });
    texCache.set(key, p);
  }
  return p;
}

/** 整材质 UV：平铺 / 旋转 / 位移，所有通道共用 */
async function texFor(f: AssetFile, srgb: boolean, gUv?: MaterialConfig['uv']) {
  const base = await loadTexture(f, srgb);
  const ru = gUv?.repeatU ?? 1;
  const rv = gUv?.repeatV ?? 1;
  const rot = gUv?.rot ?? 0;
  const ou = gUv?.offsetU ?? 0;
  const ov = gUv?.offsetV ?? 0;
  const hasUv = !(ru === 1 && rv === 1 && !rot && !ou && !ov);

  // B-002：非 1:1 贴图按宽高比修正 V 方向平铺，避免被方形 UV 拉伸（几何 UV 为世界尺度）
  if (!hasUv) {
    const img: any = base.image;
    const iw = img?.width || img?.videoWidth || 0;
    const ih = img?.height || img?.videoHeight || 0;
    const a = iw && ih ? iw / ih : 1;
    if (Math.abs(a - 1) > 0.01) {
      const t0 = base.clone();
      t0.needsUpdate = true;
      t0.wrapS = THREE.RepeatWrapping;
      t0.wrapT = THREE.RepeatWrapping;
      t0.center.set(0.5, 0.5);
      t0.repeat.set(1, a);
      t0.offset.set(0, 0);
      t0.rotation = 0;
      return t0;
    }
    return base;
  }

  const t = base.clone();
  t.needsUpdate = true;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.center.set(0.5, 0.5);
  t.repeat.set(ru, rv);
  t.offset.set(ou, ov);
  t.rotation = rot;
  return t;
}

const HSV_FUNCS = `
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return c.z * mix(vec3(1.0), rgb, c.y);
}
`;

function hslPatch(target: 'map' | 'emissive', hsl: HslCfg) {
  const h = ((hsl.h ?? 0.5) - 0.5).toFixed(5);
  const s = ((hsl.s ?? 0.5) * 2).toFixed(5);
  const l = ((hsl.l ?? 0.5) * 2).toFixed(5);
  const adjust = (tex: string) => `
    vec3 c0 = ${tex}.rgb;
    float ang = ${h} * 6.28318530718;
    float ca = cos(ang), sa = sin(ang);
    vec3 c1 = vec3(
      dot(c0, vec3(0.213 + 0.787 * ca - 0.213 * sa, 0.715 - 0.715 * ca - 0.715 * sa, 0.072 - 0.072 * ca + 0.928 * sa)),
      dot(c0, vec3(0.213 - 0.213 * ca + 0.143 * sa, 0.715 + 0.285 * ca + 0.140 * sa, 0.072 - 0.072 * ca - 0.283 * sa)),
      dot(c0, vec3(0.213 - 0.213 * ca - 0.787 * sa, 0.715 - 0.715 * ca + 0.715 * sa, 0.072 + 0.928 * ca + 0.072 * sa))
    );
    float lum = dot(c1, vec3(0.2126, 0.7152, 0.0722));
    c1 = mix(vec3(lum), c1, clamp(${s}, 0.0, 3.0));
    c1 = max(c1 * clamp(${l}, 0.0, 3.0), 0.0);
    ${tex}.rgb = c1;
  `;
  return (shader: any) => {
    if (!shader.fragmentShader.includes('rgb2hsv')) {
      shader.fragmentShader = HSV_FUNCS + shader.fragmentShader;
    }
    if (target === 'map') {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          ${adjust('sampledDiffuseColor')}
          diffuseColor *= sampledDiffuseColor;
        #endif
      `);
    } else {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
        #ifdef USE_EMISSIVEMAP
          vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
          ${adjust('emissiveColor')}
          totalEmissiveRadiance *= emissiveColor.rgb;
        #endif
      `);
    }
  };
}

function scalarPatch(kind: 'roughness' | 'metalness', comp: string, invert: boolean, intensity: number) {
  const isRough = kind === 'roughness';
  const include = isRough ? '#include <roughnessmap_fragment>' : '#include <metalnessmap_fragment>';
  const varName = isRough ? 'texelRoughness' : 'texelMetalness';
  const uv = isRough ? 'vRoughnessMapUv' : 'vMetalnessMapUv';
  const mapName = isRough ? 'roughnessMap' : 'metalnessMap';
  const factor = isRough ? 'roughnessFactor' : 'metalnessFactor';
  const baseVar = isRough ? 'roughness' : 'metalness';
  const define = isRough ? 'USE_ROUGHNESSMAP' : 'USE_METALNESSMAP';
  const k = Number.isFinite(intensity) ? intensity : 1;
  const rawName = isRough ? 'rawRough' : 'rawMetal';
  const expr = invert ? `(1.0 - ${rawName})` : rawName;

  return (shader: any) => {
    shader.fragmentShader = shader.fragmentShader.replace(include, `
      float ${factor} = ${baseVar};
      #ifdef ${define}
        vec4 ${varName} = texture2D( ${mapName}, ${uv} );
        float ${rawName} = ${varName}.${comp};
        ${factor} *= clamp(${expr} * ${k.toFixed(4)}, 0.0, 1.0);
      #endif
    `);
  };
}

export async function buildMaterial(files: AssetFile[], cfg: MaterialConfig) {
  const byId = new Map(files.map(f => [f.id, f]));
  const fileOf = (c?: ChannelCfg) => (c?.fileId ? byId.get(c.fileId) : undefined);
  const mat = new THREE.MeshPhysicalMaterial({ roughness: 1, metalness: 0 });
  const c = cfg.channels;
  const gUv = cfg.uv;
  const patches: ((s: any) => void)[] = [];
  const keys: string[] = [];
  const patch = (key: string, fn: (s: any) => void) => { keys.push(key); patches.push(fn); };
  const hslOn = (h?: HslCfg) => !!h && ((h.h ?? 0.5) !== 0.5 || (h.s ?? 0.5) !== 0.5 || (h.l ?? 0.5) !== 0.5);

  const base = fileOf(c.baseColor);
  if (base) mat.map = await texFor(base, true, gUv);
  if (base && hslOn(c.baseColor?.hsl)) patch('hsl-base', hslPatch('map', c.baseColor!.hsl!));

  const normal = fileOf(c.normal);
  if (normal) {
    mat.normalMap = await texFor(normal, false, gUv);
    const ns = c.normal?.normalSpace ?? 'gl';
    const ni = c.normal?.intensity ?? 1;
    mat.normalScale.set(ni, ni * (ns === 'dx' ? -1 : 1));
    mat.userData.normalSpace = ns;
  } else {
    mat.userData.normalSpace = 'gl';
  }

  const rough = c.roughness;
  const rf = fileOf(rough);
  if (rf && rough) {
    mat.roughnessMap = await texFor(rf, false, gUv);
    const comp = rough.channel && rough.channel !== 'rgb' ? rough.channel : 'g';
    const invert = rough.invert ?? (cfg.workflow === 'SG');
    patch(`r-${rf.id}-${comp}-${invert}-${rough.intensity}`,
      scalarPatch('roughness', comp, invert, rough.intensity ?? 0));
  }

  const met = c.metallic;
  const mf = fileOf(met);
  if (mf && met) {
    mat.metalness = 1;
    mat.metalnessMap = await texFor(mf, false, gUv);
    const comp = met.channel && met.channel !== 'rgb' ? met.channel : 'b';
    patch(`m-${mf.id}-${comp}-${met.invert}-${met.intensity}`,
      scalarPatch('metalness', comp, met.invert ?? false, met.intensity ?? 0));
  }

  const aoF = fileOf(c.ao);
  if (aoF) mat.aoMap = await texFor(aoF, false, gUv);

  const heightF = fileOf(c.height);
  if (heightF) {
    mat.displacementMap = await texFor(heightF, false, gUv);
    mat.displacementScale = (c.height?.intensity ?? 1) * 0.02;
  }

  const em = fileOf(c.emissive);
  if (em) {
    mat.emissiveMap = await texFor(em, true, gUv);
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = 1;
    if (hslOn(c.emissive?.hsl)) patch('hsl-em', hslPatch('emissive', c.emissive!.hsl!));
  }

  const op = fileOf(c.opacity);
  if (op) {
    mat.alphaMap = await texFor(op, false, gUv);
    mat.transparent = true;
    mat.opacity = 1;
  }

  if (patches.length) {
    mat.onBeforeCompile = (shader) => { for (const fn of patches) fn(shader); };
    mat.customProgramCacheKey = () => 'm:' + keys.join('|');
  }

  return mat;
}

export function channelFile(files: AssetFile[], cfg: MaterialConfig, key: ChannelKey) {
  const id = cfg.channels[key]?.fileId;
  return id ? files.find(f => f.id === id) : undefined;
}

export function missingRequired(cfg: MaterialConfig) {
  const miss: string[] = [];
  if (!cfg.channels.baseColor?.fileId) miss.push('Base Color');
  if (!cfg.channels.normal?.fileId) miss.push('Normal');
  return miss;
}

