const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stage', {
  data: () => ipcRenderer.invoke('stage:data'),
  // RAM/CPU/status for every instance at once: each one is a separate process
  // tree, so main reads it from the OS rather than from Chromium.
  metrics: () => ipcRenderer.invoke('stage:metrics'),
  close: () => ipcRenderer.invoke('stage:close'),

  start: (id) => ipcRenderer.invoke('game:start', id),
  stop: (id) => ipcRenderer.invoke('game:stop', id),
  restart: (id) => ipcRenderer.invoke('game:reload', id),

  // The click recorder lives in the main process, so the dashboard and the
  // control panel drive the very same recording.
  clickCmd: (id, cmd, opts) => ipcRenderer.invoke('game:click', id, cmd, opts),
  recSources: () => ipcRenderer.invoke('rec:sources'),
  onClickState: (cb) => ipcRenderer.on('click:state', (_e, s) => cb(s)),
});
