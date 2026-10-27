// 下载 Release 上的 SHA256SUMS.txt 与源码包，核对哈希与本地一致（校验上传完整性）
import crypto from 'node:crypto';
const H = { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'x' };
const rel = await (await fetch('https://api.github.com/repos/OMEN111111/AssetManager/releases/tags/v0.5.0', { headers: H })).json();
const get = async (name) => {
  const a = rel.assets.find(x => x.name === name);
  const r = await fetch(a.url, { headers: { ...H, Accept: 'application/octet-stream' }, redirect: 'follow' });
  return Buffer.from(await r.arrayBuffer());
};
const sums = (await get('SHA256SUMS.txt')).toString('utf8').trim();
console.log('--- 远端 SHA256SUMS.txt ---');
console.log(sums);
const zip = await get('AssetManager-0.5.0-source.zip');
const h = crypto.createHash('sha256').update(zip).digest('hex');
const expect = (sums.split('\n').find(l => l.includes('source.zip')) || '').split(/\s+/)[0];
console.log('远端源码包 sha256:', h);
console.log('与清单一致:', h === expect ? '✓' : '✗');
