import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = path.resolve('app/src/renderer/usd');
const { USDAParser } = await import(pathToFileURL(path.join(ROOT, 'USDAParser.js')).href);
const { USDComposer } = await import(pathToFileURL(path.join(ROOT, 'USDComposer.js')).href);
const fflate = await import(pathToFileURL(path.resolve('app/node_modules/three/examples/jsm/libs/fflate.module.js')).href);

// 1x1 红色 PNG
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

const usda = `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Mesh "Quad" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "vertex"
        )
        prepend rel material:binding = </Root/Mat>
    }

    def Material "Mat"
    {
        token outputs:surface.connect = </Root/Mat/Preview.outputs:surface>

        def Shader "Preview"
        {
            token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor.connect = </Root/Mat/Tex.outputs:rgb>
            float inputs:roughness = 0.4
            token outputs:surface
        }

        def Shader "Tex"
        {
            token info:id = "UsdUVTexture"
            asset inputs:file = @red.png@
            token inputs:sourceColorSpace = "sRGB"
            token inputs:wrapS = "repeat"
            token inputs:wrapT = "repeat"
            float3 outputs:rgb
        }
    }
}
`;

const dir = path.resolve('devtest/usd/work');
fs.mkdirSync(dir, { recursive: true });
const usdzPath = path.join(dir, 'test.usdz');
const zip = fflate.zipSync({ 'scene.usda': new TextEncoder().encode(usda), 'red.png': png });
fs.writeFileSync(usdzPath, zip);
console.log('usdz written', usdzPath, zip.length, 'bytes');

// —— 复刻 loadUsdModel 的 zip 分支 ——
const loaded = []; const missing = [];
globalThis.Image = class {
  constructor() { this.width = 1; this.height = 1; }
  set src(v) { this._src = v; const ok = /^blob:/.test(String(v)); (ok ? loaded : missing).push(String(v).slice(0, 40)); setTimeout(() => (ok ? this.onload?.() : this.onerror?.()), 0); }
  get src() { return this._src; }
};
const zipEntries = fflate.unzipSync(new Uint8Array(fs.readFileSync(usdzPath)));
const names = Object.keys(zipEntries);
const assets = {}; let parsedRoot = null;
for (const n of names) {
  if (/\.(usd|usda|usdc)$/i.test(n)) { assets[n] = new USDAParser().parseData(new TextDecoder().decode(zipEntries[n])); if (!parsedRoot) parsedRoot = assets[n]; }
  else if (/\.(png|jpe?g)$/i.test(n)) assets[n] = zipEntries[n];
}
const composer = new USDComposer(null);
const group = composer.compose(parsedRoot, assets, {}, '');
await Promise.all(composer.texturePromises || []);
let meshes = 0; const mats = [];
group.traverse((o) => {
  if (!o.isMesh) return;
  meshes++;
  for (const m of (Array.isArray(o.material) ? o.material : [o.material])) mats.push({ name: m.name, hasMap: !!m.map, imgOk: !!m.map?.image, color: m.color.getHexString(), rough: m.roughness });
});
console.log('usdz meshes', meshes, 'materials', JSON.stringify(mats));
console.log('blob textures loaded', loaded.length, 'missing', missing);
