const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('amApi', {
  getPath: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  // 手动选文件（目前用于挑 .uproject 装 UE 插件）；filters 形如 [{ name, extensions }]
  pickFiles: (filters) => ipcRenderer.invoke('dialog:pickFiles', filters),
  applyUpdate: (file) => ipcRenderer.invoke('update:apply', file),
  getCloseAction: () => ipcRenderer.invoke('app:getCloseAction'),
  setCloseAction: (v) => ipcRenderer.invoke('app:setCloseAction', v),
  // 把素材拖到 3ds Max / 资源管理器：走系统原生拖拽（Chromium 的 HTML5 拖拽出不了应用）
  startDrag: (payload) => ipcRenderer.send('drag:start', payload),
  platform: process.platform
});

contextBridge.exposeInMainWorld('winApi', {
  isElectron: true,
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  reload: () => ipcRenderer.send('win:reload'),
  devtools: () => ipcRenderer.send('win:devtools'),
  fullscreen: () => ipcRenderer.send('win:fullscreen')
});
