const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stage', {
  data: () => ipcRenderer.invoke('stage:data'),
  // RAM/CPU/status for every instance at once: an instance is a separate
  // process tree, so main reads it from the OS rather than from Chromium.
  metrics: () => ipcRenderer.invoke('stage:metrics'),
  close: () => ipcRenderer.invoke('stage:close'),

  // A tile's start/stop is the emulator itself starting and stopping.
  start: (id) => ipcRenderer.invoke('game:start', id),
  stop: (id) => ipcRenderer.invoke('game:stop', id),
  restartApp: (id) => ipcRenderer.invoke('game:reload', id),

  // One PNG frame for a tile. Instances are headless, so this is how the
  // dashboard sees them at all.
  frame: (id) => ipcRenderer.invoke('stage:frame', id),

  // Coordinates are a fraction of the tile (0..1); main scales them to the
  // guest's real screen, so a tile can be any size.
  tap: (id, nx, ny) => ipcRenderer.invoke('stage:tap', id, nx, ny),
  swipe: (id, x1, y1, x2, y2, ms) => ipcRenderer.invoke('stage:swipe', id, x1, y1, x2, y2, ms),
  key: (id, code) => ipcRenderer.invoke('stage:key', id, code),
  text: (id, s) => ipcRenderer.invoke('stage:text', id, s),

  // The click recorder lives in the main process, so the dashboard and the
  // control panel drive the very same recording.
  clickCmd: (id, cmd, opts) => ipcRenderer.invoke('game:click', id, cmd, opts),
  recSources: () => ipcRenderer.invoke('rec:sources'),
  onClickState: (cb) => ipcRenderer.on('click:state', (_e, s) => cb(s)),
});
