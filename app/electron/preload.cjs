const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('amApi', {
  getPath: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  applyUpdate: (file) => ipcRenderer.invoke('update:apply', file),
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
