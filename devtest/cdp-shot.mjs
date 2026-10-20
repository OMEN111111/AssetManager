import fs from 'node:fs';

const port = process.argv[2] || '9222';
const out = process.argv[3];
const action = process.argv[4] || '';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise(r => ws.onopen = r);
const send = (method, params) => new Promise(res => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});

if (action) {
  await send('Runtime.evaluate', { expression: action, awaitPromise: true });
}
await new Promise(r => setTimeout(r, 1800));
const cap = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(cap.result.data, 'base64'));
console.log('saved', out);
ws.close();
