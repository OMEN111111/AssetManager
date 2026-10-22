// 重写远端历史：把 Logs/、docs/、AGENTS.md 从**每一个历史提交**里去掉，并重建 main 与所有 tag
//
// 用法：$env:GH_TOKEN = ...; node devtest/rewrite-history.mjs [--dry]
//
// 说明：远端历史是每次发布用 API 建的（目前只有十来个提交），所以逐个重建成本很低。
// 旧提交/旧 blob 会变成不可达对象，GitHub 择机回收；所有 commit SHA 都会变（旧链接失效）。
import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'OMEN111111';
const REPO = 'AssetManager';
const dry = process.argv.includes('--dry');
const EXCLUDE = ['Logs/', 'docs/', 'AGENTS.md'];
const isExcluded = p => EXCLUDE.some(x => (x.endsWith('/') ? p.startsWith(x) : p === x));

const token = process.env.GH_TOKEN || (() => {
  try { return fs.readFileSync(path.join(process.env.TEMP || '/tmp', 'am-token.txt'), 'utf8').trim(); } catch { return ''; }
})();
if (!token) { console.error('没有 GH_TOKEN'); process.exit(1); }

async function api(p, opts = {}, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://api.github.com${p}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AssetManager-rewrite',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.headers || {})
        }
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${res.status} ${String(typeof data === 'object' ? JSON.stringify(data) : data).slice(0, 300)}`);
      return data;
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

// ---------------------------------------------------------------- 取全部提交（新→老）
const commits = [];
for (let page = 1; ; page++) {
  const batch = await api(`/repos/${OWNER}/${REPO}/commits?per_page=100&page=${page}`);
  commits.push(...batch);
  if (batch.length < 100) break;
}
commits.reverse(); // 老 → 新
console.log(`远端提交 ${commits.length} 个，按从旧到新重建`);

const map = new Map(); // 旧 sha -> 新 sha
let prevNew = null;

for (const c of commits) {
  const oldSha = c.sha;
  const t = await api(`/repos/${OWNER}/${REPO}/git/trees/${c.commit.tree.sha}?recursive=1`);
  // 只保留文件条目（blob）与子模块（commit）。递归列表里还有目录(tree)条目，
  // 若一起传进建树接口，目录会被指向旧 tree，等于把子目录里的文件又带回来。
  const entries = t.tree.filter(e => e.type === 'blob' || e.type === 'commit');
  const kept = entries.filter(e => !isExcluded(e.path));
  const dropped = entries.length - kept.length;
  const subject = String(c.commit.message).split('\n')[0].slice(0, 60);
  console.log(`  ${oldSha.slice(0, 7)} ${subject}  保留 ${kept.length} 项，去掉 ${dropped} 项`);

  if (dry) { prevNew = oldSha; continue; }

  const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      tree: kept.map(e => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha }))
    })
  });
  const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: c.commit.message,
      tree: newTree.sha,
      parents: prevNew ? [prevNew] : [],
      author: c.commit.author,
      committer: c.commit.committer
    })
  });
  map.set(oldSha, newCommit.sha);
  prevNew = newCommit.sha;
}

if (dry) { console.log('（dry run，不写远端）'); process.exit(0); }

// ---------------------------------------------------------------- 更新 refs（main + 所有 tag）
const mainNew = prevNew;
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: mainNew, force: true })
});
console.log(`main → ${mainNew.slice(0, 7)}`);

const refs = await api(`/repos/${OWNER}/${REPO}/git/refs/tags`);
for (const r of refs) {
  const old = r.object.sha;
  const neu = map.get(old) || old;
  await api(`/repos/${OWNER}/${REPO}/git/refs/${r.ref.replace('refs/', '')}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: neu, force: true })
  });
  console.log(`  ${r.ref.replace('refs/tags/', '')} : ${old.slice(0, 7)} → ${neu.slice(0, 7)}`);
}

fs.writeFileSync(path.join(process.env.TEMP || '/tmp', 'am-history-map.json'),
  JSON.stringify({ main: mainNew, map: Object.fromEntries(map) }, null, 2));
console.log(`\n完成。新 main = ${mainNew}`);
