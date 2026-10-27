// 校验远端 tag / main / package.json 版本（用 GH_TOKEN 环境变量）
const H = { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'x' };
const Hraw = { ...H, Accept: 'application/vnd.github.raw' };
const tag = await (await fetch('https://api.github.com/repos/OMEN111111/AssetManager/git/ref/tags/v0.5.0', { headers: H })).json();
console.log('tag v0.5.0 →', tag.object.sha.slice(0, 7));
const pj = await (await fetch('https://api.github.com/repos/OMEN111111/AssetManager/contents/app/package.json?ref=v0.5.0', { headers: Hraw })).text();
console.log('远端 package.json 版本:', (pj.match(/"version":\s*"([^"]+)"/) || [])[1]);
const rm = await (await fetch('https://api.github.com/repos/OMEN111111/AssetManager/git/ref/heads/main', { headers: H })).json();
console.log('远端 main:', rm.object.sha.slice(0, 7));
