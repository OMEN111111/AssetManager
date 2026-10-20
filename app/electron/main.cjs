const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.AM_PORT || 8787);
let serverProc = null;
let win = null;

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

  const port = await ensureServer();
  if (!port) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#17191D;color:#E8EAED;font:14px system-ui;padding:40px">' +
      '<h2>本地服务未启动</h2><p>请先执行 <code>npm run build:all</code>，再启动应用。</p></body>'
    ));
    return;
  }
  await win.loadURL(`http://127.0.0.1:${port}/`);
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill(); } catch { /* ignore */ }
  }
});
