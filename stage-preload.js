const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stage', {
  data: () => ipcRenderer.invoke('stage:data'),
  // ids are <webview> webContents ids; main maps each to its OS process and
  // reads Chromium's own accounting for it.
  metrics: (ids) => ipcRenderer.invoke('stage:metrics', ids),
  close: () => ipcRenderer.invoke('stage:close'),
});
