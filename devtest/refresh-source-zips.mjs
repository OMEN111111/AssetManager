// 重打每个 Release 的源码包：用 GitHub 从（重写后的）tag 生成的 zip 替换旧附件，并更新 SHA256SUMS
// 用法：$env:GH_TOKEN=...; node devtest/refresh-source-zips.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OWNER = 'OMEN111111';
const REPO = 'AssetManager';
const dry = process.argv.includes('--dry');
const tmpDir = path.join(process.env.TEMP || '/tmp', 'am-zips');
fs.mkdirSync(tmpDir, { recursive: true });

const token = process.env.GH_TOKEN || fs.readFileSync(path.join(process.env.TEMP, 'am-token.txt'), 'utf8').trim();
const BAD = ['Logs/', 'docs/', 'AGENTS.md'];

async function api(p, opts = {}, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://api.github.com${p}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AssetManager-release',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {})
        }
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${res.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

async function download(url, dest, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'AssetManager-release' },
        redirect: 'follow',
        signal: AbortSignal.timeout(180000)
      });
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return fs.statSync(dest).size;
    } catch (e) {
      console.log(`    下载失败（第 ${i}/${tries} 次）：${String(e?.message || e).slice(0, 80)}`);
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

async function upload(releaseId, file, name, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const buf = fs.readFileSync(file);
      const res = await fetch(
        `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'User-Agent': 'AssetManager-release'
          },
          body: buf
        }
      );
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

const releases = await api(`/repos/${OWNER}/${REPO}/releases?per_page=100`);
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1].split(',').map(s => s.trim()) : null;
const todo = only ? releases.filter(r => only.includes(r.tag_name)) : releases;
console.log(`共 ${releases.length} 个 Release，本次处理 ${todo.length} 个`);

for (const rel of todo) {
  const tag = rel.tag_name;
  const zipName = rel.assets.find(a => /-source\.zip$/i.test(a.name))?.name;
  const sumsName = rel.assets.find(a => /^SHA256SUMS\.txt$/i.test(a.name))?.name;
  if (!zipName) { console.log(`  ${tag}: 没有源码包，跳过`); continue; }

  // 1) 从重写后的 tag 取干净源码包
  const zipPath = path.join(tmpDir, `${tag}-${zipName}`);
  const size = await download(`https://codeload.github.com/${OWNER}/${REPO}/zip/refs/tags/${tag}`, zipPath);
  const zipSha = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  console.log(`  ${tag}: 新源码包 ${(size / 1048576).toFixed(2)}MB  sha=${zipSha.slice(0, 12)}…`);

  // 2) 现有 SHA256SUMS 里的其它行（exe 等）保持不动
  let lines = [];
  if (sumsName) {
    const a = rel.assets.find(x => x.name === sumsName);
    const res = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'am' }, redirect: 'follow' });
    const text = await res.text();
    lines = text.split(/\r?\n/).filter(Boolean)
      .filter(l => !l.endsWith(zipName))       // 去掉旧 zip 行
      .map(l => l.trim());
  }
  const sumsText = [...lines, `${zipSha}  ${zipName}`].join('\n');
  const sumsPath = path.join(tmpDir, `${tag}-SHA256SUMS.txt`);
  fs.writeFileSync(sumsPath, sumsText, 'ascii');

  if (dry) { console.log('    （dry run，不上传）'); continue; }

  // 3) 删旧附件 → 传新的
  for (const name of [zipName, sumsName].filter(Boolean)) {
    const a = rel.assets.find(x => x.name === name);
    if (a) await api(`/repos/${OWNER}/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
  }
  await upload(rel.id, zipPath, zipName);
  await upload(rel.id, sumsPath, sumsName || 'SHA256SUMS.txt');
  console.log(`    已替换 ${zipName} 与 ${sumsName || 'SHA256SUMS.txt'}`);
}
console.log('\n完成');
