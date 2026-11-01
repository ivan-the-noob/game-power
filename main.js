/* ===========================================================================
 * Game Power — main process.
 *
 * One small control window. Everything it drives lives in instances.js:
 * the original, its clones, the grid, and the per-instance metrics.
 * ======================================================================== */
const { app, BrowserWindow, ipcMain, shell, webContents } = require('electron');
const path = require('path');
const url = require('url');
const instances = require('./instances');
const updater = require('./updater');

// HTTP/3 is flaky behind some firewalls and Electron can surface the failure
// as an uncaught exception in the main process instead of a failed request.
app.commandLine.appendSwitch('disable-quic');

// A background hiccup in one game window must never take the whole app down.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (non-fatal):', err);
});

let controlWindow = null;
let stageWindow = null;

/* ---- the dashboard -------------------------------------------------------
 * Every instance as a live tile inside one window, instead of loose browser
 * windows on the desktop. A tile is a <webview> on the instance's own session
 * partition, so it is the very same instance either way.
 *
 * An instance can only be in one place at a time: two clients on one session
 * would be two logins of the same account fighting each other. So opening the
 * dashboard closes the loose windows first.
 * -------------------------------------------------------------------------- */
function openStage() {
  if (stageWindow && !stageWindow.isDestroyed()) {
    if (stageWindow.isMinimized()) stageWindow.restore();
    stageWindow.focus();
    return { ok: true, already: true };
  }
  instances.stopAll();
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
      webviewTag: true,   // the tiles themselves
    },
  });
  stageWindow.loadFile(path.join(__dirname, 'stage.html'));
  stageWindow.on('closed', () => { stageWindow = null; });
  return { ok: true };
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 740,
    minHeight: 540,
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
  createControlWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createControlWindow(); });

  // Pull the newest code from GitHub on every launch, so reopening the app is
  // all it takes to be up to date. A failure here is silent by design: the
  // app simply keeps running the code it already has.
  updater.check(true).then((r) => {
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send('update:result', r);
  }).catch(() => {});
});

// Closing the control window shuts the whole thing down, game windows
// included — orphaned instances would otherwise keep eating memory with no
// way left to see or stop them.
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { instances.stopAll(); } catch (e) { /* ignore */ } });

/* ---- IPC ----------------------------------------------------------------- */
const sync = (fn) => (...args) => {
  try { return fn(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
};
const asyncOk = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
};

ipcMain.handle('game:settings', sync(() => ({ ok: true, settings: instances.getSettings(), defaults: instances.DEFAULTS, originalId: instances.ORIGINAL_ID })));
ipcMain.handle('game:apply', sync((_e, patch) => instances.applyLive(patch)));
ipcMain.handle('game:metrics', sync(() => instances.metrics()));
ipcMain.handle('game:disk', sync(() => instances.diskUsage()));
ipcMain.handle('game:tile', sync(() => instances.tile()));

ipcMain.handle('game:start', sync((_e, id) => instances.start(id)));
ipcMain.handle('game:startAll', sync(() => instances.startAll()));
ipcMain.handle('game:stop', sync((_e, id) => instances.stop(id)));
ipcMain.handle('game:stopAll', sync(() => instances.stopAll()));
ipcMain.handle('game:focus', sync((_e, id) => instances.focus(id)));
ipcMain.handle('game:reload', sync((_e, id) => instances.reload(id)));
ipcMain.handle('game:rename', sync((_e, id, name) => instances.rename(id, name)));
// A game window reporting what its recorder is doing, on its way to the
// control panel so the buttons can show it.
ipcMain.on('rca-game:clickState', (e, state) => {
  const id = instances.idForWebContents(e.sender.id);
  if (id && controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('click:state', { id, ...(state || {}) });
  }
});

ipcMain.handle('game:click', sync((_e, id, cmd) => instances.sendClick(id, { cmd })));

ipcMain.handle('game:clone', asyncOk((_e, from, count) => instances.clone(from, count)));
ipcMain.handle('game:remove', asyncOk((_e, id) => instances.remove(id)));
ipcMain.handle('game:reset', asyncOk((_e, id) => instances.reset(id)));

/* ---- dashboard IPC -------------------------------------------------------- */
ipcMain.handle('stage:open', sync(() => openStage()));
ipcMain.handle('stage:close', sync(() => {
  if (stageWindow && !stageWindow.isDestroyed()) stageWindow.close();
  return { ok: true };
}));
ipcMain.handle('stage:data', sync(() => ({
  ...instances.stageData(),
  preloadUrl: url.pathToFileURL(path.join(__dirname, 'game-preload.js')).toString(),
})));

// RAM/CPU for tiles. Each <webview> has its own renderer process because each
// sits on its own session partition, so this is the honest per-tile cost.
ipcMain.handle('stage:metrics', sync((_e, ids) => {
  let all = [];
  try { all = app.getAppMetrics(); } catch (e) { all = []; }
  const byPid = new Map(all.map((m) => [m.pid, m]));
  const rows = [];
  for (const wcId of (Array.isArray(ids) ? ids : [])) {
    let pid = null;
    try { const wc = webContents.fromId(Number(wcId)); pid = wc && !wc.isDestroyed() ? wc.getOSProcessId() : null; }
    catch (e) { pid = null; }
    const m = pid ? byPid.get(pid) : null;
    rows.push({
      wcId: Number(wcId),
      ramMB: m ? Math.round(m.memory.workingSetSize / 1024) : 0,
      cpu: m ? Math.round((m.cpu.percentCPU || 0) * 10) / 10 : 0,
    });
  }
  return { ok: true, rows };
}));

// The tuning preload asks for these synchronously, before the game's own
// scripts run. A <webview> cannot be given launch arguments, so this is how
// the frame-rate cap and render scale reach a dashboard tile.
ipcMain.on('rca-game:tuning', (e) => {
  try { const s = instances.getSettings(); e.returnValue = { fps: s.fps || 0, dpr: s.dpr || 0 }; }
  catch (err) { e.returnValue = { fps: 0, dpr: 0 }; }
});

/* ---- code updates --------------------------------------------------------- */
ipcMain.handle('update:check', asyncOk(() => updater.check(true)));
ipcMain.handle('update:status', sync(() => ({ ok: true, ...updater.status(), cfg: updater.loadCfg() })));
ipcMain.handle('update:saveConfig', sync((_e, patch) => ({ ok: true, cfg: updater.saveCfg(patch) })));
ipcMain.handle('update:restart', sync(() => { setTimeout(() => updater.restart(), 250); return { ok: true }; }));

ipcMain.handle('app:version', sync(() => ({ ok: true, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome })));
ipcMain.handle('app:openExternal', sync((_e, url) => { shell.openExternal(String(url || '')); return { ok: true }; }));
