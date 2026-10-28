import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const ROOT = path.resolve('app/src/renderer/usd');
const { USDAParser } = await import(pathToFileURL(path.join(ROOT, 'USDAParser.js')).href);
const { USDCParser } = await import(pathToFileURL(path.join(ROOT, 'USDCParser.js')).href);
const { USDComposer } = await import(pathToFileURL(path.join(ROOT, 'USDComposer.js')).href);
globalThis.Image = class { constructor(){ this.width=this.height=1024; } set src(v){ this._src=v; setTimeout(()=>this.onload?.(),0);} get src(){return this._src;} };

const file = process.argv[2];
const parse = (buf) => buf.slice(0,8).toString('latin1') === 'PXR-USDC'
  ? new USDCParser().parseData(buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength))
  : new USDAParser().parseData(buf.toString('utf8'));
const refsOf = (p) => { const out=[]; for (const k in p.specsByPath||{}) { const f=p.specsByPath[k].fields||{}; for (const b of [f.references,f.payload]) { if(!b) continue; for (const v of (Array.isArray(b)?b:[b])) { if (typeof v==='string'){const m=v.match(/@([^@]+)@/); if(m) out.push(m[1]);} else if (v?.assetPath) out.push(v.assetPath); } } } return out; };
const dirOf = (u) => u.slice(0, u.lastIndexOf('/')+1);
const toFile = (p) => pathToFileURL(path.resolve(p)).href;
const basePath = dirOf(toFile(file));
const parsedRoot = parse(fs.readFileSync(file));
const assets = {}; const seen = new Set(); const q = [];
const pushChildren = (p, from, depth) => { for (const r of refsOf(p)) { if (!/\.(usd|usda|usdc)$/i.test(r)) continue; let rp=r; if (rp.startsWith('./')) rp=rp.slice(2); const url=dirOf(from)+rp; if (seen.has(url)) continue; seen.add(url); q.push({url,depth}); } };
pushChildren(parsedRoot, toFile(file), 1);
while (q.length) { const b=q.splice(0,q.length); for (const {url,depth} of b) { if (depth>6) continue; let buf; try { buf=fs.readFileSync(fileURLToPath(url)); } catch { continue; } const p=parse(buf); assets[url]=p; pushChildren(p,url,depth+1); } }
const composer = new USDComposer(null);
const group = composer.compose(parsedRoot, assets, {}, basePath);
await Promise.all(composer.texturePromises||[]);
const walk = (o, d=0) => {
  const mats = o.isMesh ? (Array.isArray(o.material)?o.material:[o.material]) : [];
  console.log('  '.repeat(d) + (o.type||'?') + ' "' + o.name + '"' + (o.isMesh ? '  subsets=' + JSON.stringify(o.userData?.subsetNames||null) + ' mats=' + mats.map(m=>m?.name+'('+(m?.map?'map':'nomap')+')').join(',') : ''));
  for (const c of o.children) walk(c, d+1);
};
walk(group);
