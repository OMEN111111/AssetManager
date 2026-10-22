const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeImage, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.AM_PORT || 8787);
let serverProc = null;
let win = null;
let dragIcon = null;
let tray = null;
let quitting = false;

function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch { /* ignore */ }
  return s;
}
function closeAction() {
  const a = readSettings().closeAction;
  return (a === 'tray' || a === 'quit') ? a : 'ask';
}
function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  win.show();
  win.focus();
}
function createTray() {
  if (tray) return;
  const p = path.join(__dirname, '..', 'build', 'icon.png');
  let img = nativeImage.createEmpty();
  try { if (fs.existsSync(p)) img = nativeImage.createFromBuffer(fs.readFileSync(p)); } catch { /* ignore */ }
  try {
    tray = new Tray(img);
    tray.setToolTip('AssetManager');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 AssetManager', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch { tray = null; }
}

/** 拖拽时跟随鼠标的小图标：必须给 NativeImage，打包后 asar 里的路径原生代码读不了 */
function loadDragIcon() {
  if (dragIcon) return dragIcon;
  const candidates = [
    path.join(__dirname, '..', 'build', 'drag-icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png')
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromBuffer(fs.readFileSync(p));
      if (!img.isEmpty()) { dragIcon = img; return dragIcon; }
    } catch { /* try next */ }
  }
  try { dragIcon = nativeImage.createEmpty(); } catch { dragIcon = null; }
  return dragIcon;
}

/** 拖拽排错日志（%APPDATA%\assetmanager-app\drag.log），只在开发/反馈时看 */
function dlog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'drag.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch { /* ignore */ }
}

function probe(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/api/state`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(700, () => { req.destroy(); resolve(null); });
  });
}

async function ensureServer() {
  const ownRoot = app.getAppPath();
  for (let port = PORT; port < PORT + 12; port++) {
    const state = await probe(port);
    if (state && state.appRoot === ownRoot) return port;
    if (state) continue; // 端口被别的东西占用（例如旧版本的子进程），换一个
    const serverPath = path.join(__dirname, '..', 'build', 'server.mjs');
    if (!fs.existsSync(serverPath)) {
      dialog.showErrorBox('缺少服务端构建', '请先运行 npm run build:all 生成 build/server.mjs');
      return 0;
    }
    serverProc = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(port),
        AM_ROOT: ownRoot,
        AM_DATA: app.getPath('userData')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProc.stdout.on('data', d => console.log('[server]', String(d).trim()));
    serverProc.stderr.on('data', d => console.error('[server]', String(d).trim()));
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const st = await probe(port);
      if (st && st.appRoot === ownRoot) return port;
    }
  }
  return 0;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '添加素材库…',
          accelerator: 'CmdOrCtrl+O',
          click: () => win?.webContents.executeJavaScript(
            "document.querySelector('.top-actions .iconbtn:last-child')?.click()"
          )
        },
        {
          label: '重新扫描当前库',
          accelerator: 'CmdOrCtrl+R',
          click: () => win?.webContents.executeJavaScript(
            "document.querySelector('.top-actions .iconbtn:first-child')?.click()"
          )
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 AssetManager',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'AssetManager',
            message: 'AssetManager',
            detail: `本地资产库管理器\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n服务端口 ${PORT}`
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1280,
    minHeight: 800,
    backgroundColor: '#17191D',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: false,
    hasShadow: true,
    title: 'AssetManager',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 渲染进程崩溃/卡死时自动重载，避免「黑屏只能重启」（B-004）
  let lastAutoReload = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details);
    if (Date.now() - lastAutoReload > 10000) {
      lastAutoReload = Date.now();
      try { win.reload(); } catch { /* ignore */ }
    }
  });
  win.webContents.on('unresponsive', () => console.warn('[renderer unresponsive]'));
  win.webContents.on('responsive', () => console.log('[renderer responsive]'));

  const port = await ensureServer();
  if (!port) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#17191D;color:#E8EAED;font:14px system-ui;padding:40px">' +
      '<h2>本地服务未启动</h2><p>请先执行 <code>npm run build:all</code>，再启动应用。</p></body>'
    ));
    return;
  }
  await win.loadURL(`http://127.0.0.1:${port}/`);
  createTray();
  win.on('close', async (e) => {
    if (quitting) return;
    const act = closeAction();
    if (act === 'quit') { quitting = true; app.quit(); return; }
    if (act === 'tray') { e.preventDefault(); win.hide(); return; }
    e.preventDefault();
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['最小化到托盘', '直接关闭', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: '记住我的选择',
      message: '关闭 AssetManager？',
      detail: '最小化到托盘后程序会在后台运行（占用更低），可从托盘图标重新打开。'
    });
    if (r.response === 0) {
      if (r.checkboxChecked) writeSettings({ closeAction: 'tray' });
      win.hide();
    } else if (r.response === 1) {
      if (r.checkboxChecked) writeSettings({ closeAction: 'quit' });
      quitting = true;
      app.quit();
    }
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.assetmanager.app');
  Menu.setApplicationMenu(null);
  ipcMain.on('win:minimize', () => win?.minimize());
  ipcMain.on('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('win:close', () => win?.close());
  ipcMain.handle('app:getCloseAction', () => closeAction());
  ipcMain.handle('app:setCloseAction', (_e, v) => {
    writeSettings({ closeAction: v === 'tray' || v === 'quit' ? v : 'ask' });
    return closeAction();
  });
  ipcMain.on('win:reload', () => win?.webContents.reload());
  ipcMain.on('win:devtools', () => win?.webContents.toggleDevTools());
  ipcMain.on('win:fullscreen', () => {
    if (!win) return;
    win.setFullScreen(!win.isFullScreen());
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    if (!win) return '';
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? '' : (r.filePaths[0] || '');
  });
  ipcMain.on('drag:start', (event, payload) => {
    if (!win || !payload) return;
    const files = (Array.isArray(payload.files) ? payload.files : [])
      .filter(f => typeof f === 'string' && f && fs.existsSync(f));
    if (!files.length) return;
    // 用发送方自己的 webContents（Electron 官方示例的写法），并给拖拽图标一个真正的 NativeImage：
    // 打包后 icon.png 在 app.asar 里，原生代码读不了 asar 路径，直接传路径可能让进程崩掉。
    const wc = event.sender && !event.sender.isDestroyed() ? event.sender : win.webContents;
    const icon = loadDragIcon();
    const item = { file: files[0], files, icon };
    try {
      dlog('drag start ' + files[0]);
      wc.startDrag(item);
      dlog('drag returned');
    } catch (err) {
      dlog('drag failed: ' + (err && err.message ? err.message : String(err)));
      console.error('startDrag failed', err);
    }
  });
  ipcMain.handle('update:apply', async (_e, file) => {
    if (!app.isPackaged) return { ok: false, error: '开发环境不支持自动更新' };
    if (!file || !fs.existsSync(file)) return { ok: false, error: '更新文件不存在' };
    const target = process.execPath;
    const bat = path.join(app.getPath('temp'), `assetmanager-update-${Date.now()}.cmd`);
    const lines = [
      '@echo off',
      'setlocal',
      ':wait',
      `tasklist /FI "PID eq ${process.pid}" /NH 2>nul | find "${process.pid}" >nul`,
      'if not errorlevel 1 (timeout /t 1 /nobreak >nul & goto wait)',
      `copy /Y "${file}" "${target}" >nul`,
      `start "" "${target}"`,
      'del "%~f0"'
    ];
    try {
      fs.writeFileSync(bat, lines.join('\r\n'), 'utf8');
      require('node:child_process').spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 400);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (quitting || !tray)) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch { /* ignore */ }
  }
});
