// 给置换对齐探针用的极小静态服务：静态文件 + /api/path-file（真实素材库文件）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('devtest/disp');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.css': 'text/css' };

// 装配器真机验证页要的那些假接口
const BRICKS = 'F:/02AssetLibrary/Asset/02_Materials/Bricks/Bricks_4k_001/';
const FILE_MAP = {
  21: BRICKS + 'Bricks_4k_Basecolor.jpg',
  22: BRICKS + 'Bricks_4k_Height.jpg',
  23: BRICKS + 'Bricks_4k_Normal.jpg',
  24: BRICKS + 'Bricks_4k_Roughness.jpg',
  25: BRICKS + 'Bricks_4k_AO.jpg'
};
const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj)); };

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/api/path-file') {
    const p = u.searchParams.get('path') || '';
    if (!fs.existsSync(p)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
    return;
  }
  if (u.pathname.startsWith('/api/file/')) {
    const p = FILE_MAP[Number(u.pathname.split('/').pop())];
    if (!p || !fs.existsSync(p)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
    return;
  }
  if (u.pathname === '/api/state') return json(res, { libraries: [] });
  if (u.pathname === '/api/assets') return json(res, { assets: [], total: 0 });
  if (u.pathname === '/api/geometry/list') return json(res, { files: [] });
  if (u.pathname === '/api/texture/export' || u.pathname === '/api/mtlx' || u.pathname === '/api/path/write-text') {
    return json(res, { ok: false, error: 'test harness' });
  }
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/index.html';
  const abs = path.join(ROOT, rel.replace(/^\/+/, ''));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404).end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
});
const port = Number(process.argv[2] || 8798);
srv.listen(port, '127.0.0.1', () => console.log('serving', ROOT, 'on', port));
