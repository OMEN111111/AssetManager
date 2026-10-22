// 用 GitHub API 发布：把本地快照作为远端 main 的新提交，建 tag 与 Release，再上传附件
// （本机 github.com 网页不通，api.github.com / uploads.github.com 可用）
//
// 用法：
//   $env:GH_TOKEN = (git credential fill 拿到的 token)
//   node devtest/release-gh.mjs <版本号> <附件目录> [--dry]
//
// 做法：远端 HEAD 的 tree 拿来对比，本地缺的 blob 先上传，然后用「本地全量」建新 tree，
// parent 用远端 HEAD（本地历史与远端分叉，所以不 push，直接 API 建提交）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OWNER = 'OMEN111111';
const REPO = 'AssetManager';
const version = process.argv[2];
const distDir = process.argv[3] || 'dist-release';
const dry = process.argv.includes('--dry');
if (!version) {
  console.error('用法: node devtest/release-gh.mjs <版本号> [附件目录] [--dry]');
  process.exit(1);
}

const token = process.env.GH_TOKEN || (() => {
  try { return fs.readFileSync(path.join(process.env.TEMP || '/tmp', 'am-token.txt'), 'utf8').trim(); } catch { return ''; }
})();
if (!token) { console.error('没有 GH_TOKEN'); process.exit(1); }

const git = (...args) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024 }).toString();

async function api(p, opts = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AssetManager-release',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data).slice(0, 400) : String(data).slice(0, 400);
    throw new Error(`${opts.method || 'GET'} ${p} → ${res.status} ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------- 1. 远端现状
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
const remoteHead = ref.object.sha;
const remoteCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${remoteHead}`);
const remoteTreeSha = remoteCommit.tree.sha;
const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${remoteTreeSha}?recursive=1`);
const remoteBlobs = new Map();
for (const e of remoteTree.tree) if (e.type === 'blob') remoteBlobs.set(e.path, e.sha);
console.log(`远端 main=${remoteHead.slice(0, 7)}，文件 ${remoteBlobs.size} 个`);

// ---------------------------------------------------------------- 2. 本地快照
const ls = git('ls-files', '-s', '-z').split('\0').filter(Boolean);
const localFiles = ls.map(line => {
  const m = line.match(/^(\d+)\s+([0-9a-f]+)\s+(\d+)\t(.*)$/);
  return m ? { mode: m[1], sha: m[2], path: m[4] } : null;
}).filter(Boolean);
console.log(`本地快照 ${localFiles.length} 个文件`);

const needUpload = localFiles.filter(f => remoteBlobs.get(f.path) !== f.sha);
const removed = [...remoteBlobs.keys()].filter(p => !localFiles.some(f => f.path === p));
console.log(`需要上传 blob: ${needUpload.length}，远端多余文件（将被删除）: ${removed.length}`);
if (removed.length) console.log('  删除:', removed.slice(0, 12).join(', ') + (removed.length > 12 ? ' …' : ''));

if (dry) {
  console.log('（dry run，不写远端）');
  process.exit(0);
}

// ---------------------------------------------------------------- 3. 上传 blob
let done = 0;
for (const f of needUpload) {
  const buf = execFileSync('git', ['cat-file', 'blob', f.sha], { maxBuffer: 256 * 1024 * 1024 });
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' })
  });
  f.sha = blob.sha;
  done++;
  if (done % 20 === 0) console.log(`  已上传 ${done}/${needUpload.length}`);
}
console.log(`blob 上传完成（${done} 个）`);

// ---------------------------------------------------------------- 4. 新 tree / commit
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({
    tree: localFiles.map(f => ({
      path: f.path,
      mode: f.mode === '100755' ? '100755' : '100644',
      type: 'blob',
      sha: f.sha
    }))
  })
});
console.log(`新 tree ${tree.sha.slice(0, 7)}`);

const message = `release: v${version}（FBX/OBJ 自动转 GLB 进 SketchUp，SketchUp 插件 0.1.1）`;
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [remoteHead] })
});
console.log(`新提交 ${commit.sha.slice(0, 7)}`);

await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: true })
});
console.log('main 已更新');

// ---------------------------------------------------------------- 5. tag
const tagName = `v${version}`;
try {
  await api(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/tags/${tagName}`, sha: commit.sha })
  });
  console.log(`tag ${tagName} 已创建`);
} catch (e) {
  if (String(e.message).includes('422')) {
    await api(`/repos/${OWNER}/${REPO}/git/refs/tags/${tagName}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: true })
    });
    console.log(`tag ${tagName} 已移动`);
  } else throw e;
}

// ---------------------------------------------------------------- 6. Release
const body = fs.existsSync('dist-release/release-notes.md')
  ? fs.readFileSync('dist-release/release-notes.md', 'utf8')
  : `v${version}`;
let release;
try {
  release = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tagName,
      name: `AssetManager ${version}`,
      body,
      draft: false,
      prerelease: false
    })
  });
} catch (e) {
  if (!String(e.message).includes('422')) throw e;
  const list = await api(`/repos/${OWNER}/${REPO}/releases`);
  release = list.find(r => r.tag_name === tagName);
  if (!release) throw new Error('Release 已存在但取不到');
  console.log('Release 已存在，改为上传附件');
}
console.log(`Release: ${release.html_url}`);

// ---------------------------------------------------------------- 7. 附件
const files = fs.readdirSync(distDir).filter(f => /\.(exe|zip|txt)$/i.test(f));
for (const name of files) {
  const full = path.join(distDir, name);
  const buf = fs.readFileSync(full);
  const existing = (release.assets || []).find(a => a.name === name);
  if (existing) {
    await api(`/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
  }
  const up = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
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
  if (!up.ok) throw new Error(`上传 ${name} 失败: ${up.status} ${(await up.text()).slice(0, 200)}`);
  console.log(`  已上传 ${name}（${(buf.length / 1048576).toFixed(1)} MB）`);
}

console.log('\n完成：');
console.log('  提交', commit.sha);
console.log('  Release', release.html_url);
