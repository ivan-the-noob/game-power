const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Is Android set up on this machine, and fetch it if not.
  androidHealth: () => ipcRenderer.invoke('android:health'),
  androidInstall: () => ipcRenderer.invoke('android:install'),
  onAndroidLog: (cb) => ipcRenderer.on('android:log', (_e, line) => cb(line)),

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

  // The one app: open the site in the guest's browser, install an APK from
  // the PC, see what is installed, launch it.
  openSite: (id, url) => ipcRenderer.invoke('app:openSite', id, url),
  installApk: (id, apkPath) => ipcRenderer.invoke('app:installApk', id, apkPath),
  listApps: (id) => ipcRenderer.invoke('app:listApps', id),
  launch: (id, pkg) => ipcRenderer.invoke('app:launch', id, pkg),
  setPkg: (id, pkg) => ipcRenderer.invoke('app:setPkg', id, pkg),

  // cmd: record | stopRecord | play | stop | clear | state | exportSteps | importSteps
  // opts.from lets an instance replay another instance's recording.
  clickCmd: (id, cmd, opts) => ipcRenderer.invoke('game:click', id, cmd, opts),
  recSources: () => ipcRenderer.invoke('rec:sources'),
  onClickState: (cb) => ipcRenderer.on('click:state', (_e, s) => cb(s)),

  groupList: () => ipcRenderer.invoke('group:list'),
  groupCreate: (name) => ipcRenderer.invoke('group:create', name),
  groupDelete: (name) => ipcRenderer.invoke('group:delete', name),
  groupSet: (ids, name) => ipcRenderer.invoke('group:set', ids, name),
  credGet: (id) => ipcRenderer.invoke('cred:get', id),
  credSet: (id, cred) => ipcRenderer.invoke('cred:set', id, cred),

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
