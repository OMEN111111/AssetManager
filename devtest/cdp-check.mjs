const port = process.argv[2] || '9222';
const expr = process.argv[3];

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// 可选 --match=<子串>：多个 page 时按 URL 选（headless Chrome 会有扩展页）
const match = (process.argv.find(a => a.startsWith('--match=')) || '').split('=')[1] || '';
const page = targets.find(t => t.type === 'page' && (!match || String(t.url || '').includes(match)));
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise(r => ws.onopen = r);

function send(method, params) {
  return new Promise(res => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r?.result?.result?.value ?? r, null, 2));
ws.close();
