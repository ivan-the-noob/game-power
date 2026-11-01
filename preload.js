const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('game:settings'),
  apply: (patch) => ipcRenderer.invoke('game:apply', patch),
  metrics: () => ipcRenderer.invoke('game:metrics'),
  disk: () => ipcRenderer.invoke('game:disk'),
  tile: () => ipcRenderer.invoke('game:tile'),
  openStage: () => ipcRenderer.invoke('stage:open'),

  start: (id) => ipcRenderer.invoke('game:start', id),
  startAll: () => ipcRenderer.invoke('game:startAll'),
  stop: (id) => ipcRenderer.invoke('game:stop', id),
  stopAll: () => ipcRenderer.invoke('game:stopAll'),
  focus: (id) => ipcRenderer.invoke('game:focus', id),
  reload: (id) => ipcRenderer.invoke('game:reload', id),
  rename: (id, name) => ipcRenderer.invoke('game:rename', id, name),
  clickCmd: (id, cmd) => ipcRenderer.invoke('game:click', id, cmd),
  onClickState: (cb) => ipcRenderer.on('click:state', (_e, s) => cb(s)),

  clone: (from, count) => ipcRenderer.invoke('game:clone', from, count),
  remove: (id) => ipcRenderer.invoke('game:remove', id),
  reset: (id) => ipcRenderer.invoke('game:reset', id),

  checkUpdate: () => ipcRenderer.invoke('update:check'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateSaveConfig: (patch) => ipcRenderer.invoke('update:saveConfig', patch),
  restart: () => ipcRenderer.invoke('update:restart'),
  onUpdateResult: (cb) => ipcRenderer.on('update:result', (_e, r) => cb(r)),
  version: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
