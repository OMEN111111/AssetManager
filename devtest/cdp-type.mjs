const port = process.argv[2];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
};

await ev(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
[...document.querySelectorAll('.top-actions .iconbtn')].find(b=>(b.title||'').includes('设置'))?.click();await s(500);
[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.includes('添加素材库'))?.click();await s(600);
const inp=[...document.querySelectorAll('.modal-input')].pop(); inp.focus(); inp.value=''; return true;})()`);

await send('Input.insertText', { text: 'D:\\TestLib' });
await new Promise(r => setTimeout(r, 400));
console.log('after insert:', await ev(`[...document.querySelectorAll('.modal-input')].pop().value`));

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
await new Promise(r => setTimeout(r, 400));
console.log('after backspace:', await ev(`[...document.querySelectorAll('.modal-input')].pop().value`));

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
await new Promise(r => setTimeout(r, 400));
console.log('after key a:', await ev(`[...document.querySelectorAll('.modal-input')].pop().value`));
ws.close();
