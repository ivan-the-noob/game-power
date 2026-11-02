/* ===========================================================================
 * Game Power — main process.
 *
 * One control window plus a dashboard. The engine lives in instances.js (the
 * registry, building, cloning, metrics), winclient.js (the game's own Windows
 * client) and recorder.js (the click recorder).
 * ======================================================================== */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const instances = require('./instances');
const recorder = require('./recorder');
const updater = require('./updater');

// HTTP/3 is flaky behind some firewalls and Electron can surface the failure
// as an uncaught exception in the main process instead of a failed request.
app.commandLine.appendSwitch('disable-quic');

// A background hiccup must never take the whole app down and orphan running
// game clients.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (non-fatal):', err);
});

let controlWindow = null;
let stageWindow = null;

const toControl = (channel, payload) => {
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send(channel, payload);
};

function openStage() {
  if (stageWindow && !stageWindow.isDestroyed()) {
    if (stageWindow.isMinimized()) stageWindow.restore();
    stageWindow.focus();
    return { ok: true, already: true };
  }
  stageWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Game Power — Dashboard',
    backgroundColor: '#050d18',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'stage-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  stageWindow.loadFile(path.join(__dirname, 'stage.html'));
  stageWindow.on('closed', () => { stageWindow = null; });
  return { ok: true };
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'Game Power',
    backgroundColor: '#050d18',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  controlWindow.loadFile(path.join(__dirname, 'index.html'));
  controlWindow.on('closed', () => { controlWindow = null; });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.rca.gamepower');
  // The recorder is told how to reach a game window rather than importing it,
  // so it stays the same code whatever the engine underneath is.
  recorder.configure({
    onState: (id, state) => toControl('click:state', { id, ...state }),
    injector: instances.injector,
  });
  createControlWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createControlWindow(); });
  updater.check(true).then((r) => toControl('update:result', r)).catch(() => {});
});

app.on('window-all-closed', () => app.quit());

/* Closing has to be awaited: a game client is a separate process, and quitting
 * without stopping it leaves it running with no UI left to stop it. */
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  recorder.stopAll();
  const done = () => { try { app.exit(0); } catch (err) { process.exit(0); } };
  instances.stopAllNow().then(done).catch(done);
  setTimeout(done, 15000);
});

/* ---- IPC ----------------------------------------------------------------- */
const sync = (fn) => (...args) => {
  try { return fn(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
};
const asyncOk = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
};

/* ---- setup: where is the game installed? --------------------------------- */
ipcMain.handle('game:health', sync(() => instances.health()));
ipcMain.handle('game:setPath', asyncOk(async (_e, dir) => {
  let d = dir;
  if (!d) {
    const win = BrowserWindow.getFocusedWindow() || controlWindow;
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose the folder the game is installed in',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'Cancelled.' };
    d = picked.filePaths[0];
  }
  return instances.setGamePath(d);
}));
ipcMain.handle('game:build', asyncOk((_e, id) => instances.build(id, null)));
ipcMain.handle('game:openFolder', sync((_e, id) => {
  shell.openPath(instances.clientDir(id));
  return { ok: true };
}));

/* ---- settings + metrics -------------------------------------------------- */
ipcMain.handle('game:settings', sync(() => ({ ok: true, settings: instances.getSettings(), defaults: instances.DEFAULTS, originalId: instances.ORIGINAL_ID })));
ipcMain.handle('game:apply', sync((_e, patch) => instances.applyLive(patch)));
ipcMain.handle('game:metrics', asyncOk(() => instances.metrics()));
ipcMain.handle('game:disk', asyncOk(() => instances.diskUsage()));
ipcMain.handle('game:tile', sync(() => instances.tile()));

/* ---- lifecycle ----------------------------------------------------------- */
ipcMain.handle('game:start', sync((_e, id) => instances.start(id)));
ipcMain.handle('game:startAll', sync(() => instances.startAll()));
ipcMain.handle('game:stop', asyncOk((_e, id) => instances.stopNow(id)));
ipcMain.handle('game:stopAll', asyncOk(() => instances.stopAllNow()));
ipcMain.handle('game:focus', sync((_e, id) => instances.focus(id)));
ipcMain.handle('game:reload', asyncOk((_e, id) => instances.reload(id)));
ipcMain.handle('game:rename', sync((_e, id, name) => instances.rename(id, name)));
ipcMain.handle('game:clone', asyncOk((_e, from, count) => instances.clone(from, count)));
ipcMain.handle('game:remove', asyncOk((_e, id) => instances.remove(id)));
ipcMain.handle('game:reset', asyncOk((_e, id) => instances.reset(id)));

/* ---- groups + saved credentials ------------------------------------------ */
ipcMain.handle('group:list', sync(() => ({ ok: true, groups: instances.listGroups() })));
ipcMain.handle('group:create', sync((_e, name) => instances.createGroup(name)));
ipcMain.handle('group:delete', sync((_e, name) => instances.deleteGroup(name)));
ipcMain.handle('group:set', sync((_e, ids, name) => instances.setGroup(ids, name)));
ipcMain.handle('cred:get', sync((_e, id) => instances.getCred(id)));
ipcMain.handle('cred:set', sync((_e, id, cred) => instances.setCred(id, cred)));

/* ---- the click recorder -------------------------------------------------- */
ipcMain.handle('game:click', asyncOk((_e, id, cmd, opts) => recorder.command(id, cmd, instances.recorderCfg(), opts)));
ipcMain.handle('rec:sources', sync(() => ({
  ok: true,
  ids: recorder.withRecordings(instances.stageData().rows.map((r) => r.id)),
})));

/* ---- dashboard ----------------------------------------------------------- */
ipcMain.handle('stage:open', sync(() => openStage()));
ipcMain.handle('stage:close', sync(() => {
  if (stageWindow && !stageWindow.isDestroyed()) stageWindow.close();
  return { ok: true };
}));
ipcMain.handle('stage:data', sync(() => instances.stageData()));
ipcMain.handle('stage:metrics', asyncOk(() => instances.metrics()));

/* ---- reaching into a game window ------------------------------------------
 * Clicks are given as a fraction of the window so the caller need not know
 * its size; `real` picks a system mouse event over a posted message when the
 * game ignores the latter (see winapi.js).
 * -------------------------------------------------------------------------- */
ipcMain.handle('win:click', asyncOk((_e, id, nx, ny, real) => instances.clickNorm(id, nx, ny, { real })));
ipcMain.handle('win:type', asyncOk((_e, id, text) => instances.typeInto(id, text)));
ipcMain.handle('win:key', asyncOk((_e, id, name) => instances.keyInto(id, name)));
ipcMain.handle('win:focus', asyncOk((_e, id) => instances.focusWindow(id)));
ipcMain.handle('win:info', asyncOk(async (_e, id) => {
  const w = await instances.windowOf(id);
  return w ? { ok: true, ...w } : { ok: false, error: 'No window yet.' };
}));

/* ---- code updates -------------------------------------------------------- */
ipcMain.handle('update:check', asyncOk(() => updater.check(true)));
ipcMain.handle('update:status', sync(() => ({ ok: true, ...updater.status(), cfg: updater.loadCfg() })));
ipcMain.handle('update:saveConfig', sync((_e, patch) => ({ ok: true, cfg: updater.saveCfg(patch) })));

/* Restart to run code that has already been downloaded. Awaited, so the window
 * can be told when a restart is impossible instead of appearing to do nothing. */
ipcMain.handle('update:restart', asyncOk(async () => {
  const r = updater.prepareRestart();
  if (!r.ok) return r;
  setTimeout(() => {
    recorder.stopAll();
    instances.stopAllNow()
      .catch(() => {})
      .then(() => { quitting = true; app.relaunch(r.relaunch); app.exit(0); });
  }, 150);
  return { ok: true, note: 'Closing the clients, then restarting.' };
}));

ipcMain.handle('app:version', sync(() => ({ ok: true, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome })));
ipcMain.handle('app:openExternal', sync((_e, url) => { shell.openExternal(String(url || '')); return { ok: true }; }));
