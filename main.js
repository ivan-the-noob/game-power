/* ===========================================================================
 * Game Power — main process.
 *
 * One small control window plus a dashboard. Everything it drives lives in
 * instances.js (the registry, cloning, metrics), android.js (the emulator) and
 * recorder.js (the click recorder).
 * ======================================================================== */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');

/* One data folder, however the app was started.
 *
 * userData is appData plus app.getName(), and a packaged build reports its
 * productName ("Game Power") while a source run reports the package name
 * ("game-power"). Left alone that is two separate folders, so installing the
 * .exe would present an empty instance list beside an original that already
 * has the game on it — the instances, the logins and the recordings would all
 * appear to have vanished.
 *
 * Must come before anything resolves a path, which is why it is above the
 * requires that eventually ask for one. */
app.setName('game-power');

const instances = require('./instances');
const recorder = require('./recorder');
const updater = require('./updater');

// HTTP/3 is flaky behind some firewalls and Electron can surface the failure
// as an uncaught exception in the main process instead of a failed request.
app.commandLine.appendSwitch('disable-quic');

// A background hiccup must never take the whole app down — least of all now,
// when going down means orphaning running virtual machines.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (non-fatal):', err);
});

let controlWindow = null;
let stageWindow = null;

const toControl = (channel, payload) => {
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.webContents.send(channel, payload);
};

/* ---- the dashboard -------------------------------------------------------
 * Every instance as a live tile in one window. An instance is headless, so a
 * tile is a stream of PNG frames pulled over ADB rather than an embedded
 * window — see instances.js for why.
 * -------------------------------------------------------------------------- */
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

  // The recorder reports progress straight to the control panel's buttons.
  recorder.configure({
    onState: (id, state) => toControl('click:state', { id, ...state }),
  });

  createControlWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createControlWindow(); });

  // Pull the newest code from GitHub on every launch, so reopening the app is
  // all it takes to be up to date. A failure here is silent by design.
  updater.check(true).then((r) => toControl('update:result', r)).catch(() => {});
});

app.on('window-all-closed', () => app.quit());

/* Shutting down has to be awaited. An emulator is a separate process holding a
 * multi-gigabyte disk image open; killing Electron without stopping it leaves
 * the VM running with no UI left to stop it, and can tear the data partition
 * an account lives in. */
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  recorder.stopAll();
  instances.stopWatchdog();
  const done = () => { try { app.exit(0); } catch (err) { process.exit(0); } };
  instances.stopAllNow().then(done).catch(done);
  // Never hang on shutdown: if a guest will not go quietly, go anyway.
  setTimeout(done, 20000);
});

/* ---- IPC ----------------------------------------------------------------- */
const sync = (fn) => (...args) => {
  try { return fn(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
};
const asyncOk = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { return { ok: false, error: String(e.message || e) }; }
};

/* ---- setup --------------------------------------------------------------- */
ipcMain.handle('android:health', sync(() => instances.health()));
ipcMain.handle('android:install', asyncOk(() => instances.installDeps((line) => toControl('android:log', line))));

/* ---- settings + metrics --------------------------------------------------- */
ipcMain.handle('game:settings', sync(() => ({ ok: true, settings: instances.getSettings(), defaults: instances.DEFAULTS, originalId: instances.ORIGINAL_ID })));
ipcMain.handle('game:apply', sync((_e, patch) => instances.applyLive(patch)));
ipcMain.handle('game:metrics', asyncOk(() => instances.metrics()));
ipcMain.handle('game:disk', asyncOk(() => instances.diskUsage()));
ipcMain.handle('game:tile', sync(() => instances.tile()));

/* ---- lifecycle ------------------------------------------------------------ */
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
ipcMain.handle('game:removeClones', asyncOk((_e, opts) => instances.removeClones(opts)));
ipcMain.handle('game:diag', asyncOk(() => instances.diagnostics()));

/* ---- the one app ---------------------------------------------------------- */
ipcMain.handle('app:openSite', asyncOk((_e, id, url) => instances.openGameSite(id, url)));
ipcMain.handle('app:listApps', asyncOk((_e, id) => instances.listApps(id)));
ipcMain.handle('app:launch', asyncOk((_e, id, pkg) => instances.launchApp(id, pkg)));
ipcMain.handle('app:setPkg', sync((_e, id, pkg) => instances.setPkg(id, pkg)));

// Install an APK you already downloaded on the PC. Downloading it inside the
// guest's own browser is the other way in, and needs no dialog.
ipcMain.handle('app:installApk', asyncOk(async (_e, id, apkPath) => {
  let file = apkPath;
  if (!file) {
    const win = BrowserWindow.getFocusedWindow() || controlWindow;
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose the game APK',
      properties: ['openFile'],
      filters: [{ name: 'Android app', extensions: ['apk'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'Cancelled.' };
    file = picked.filePaths[0];
  }
  return instances.installApk(id, file);
}));

/* ---- groups + saved credentials ------------------------------------------- */
ipcMain.handle('group:list', sync(() => ({ ok: true, groups: instances.listGroups() })));
ipcMain.handle('group:create', sync((_e, name) => instances.createGroup(name)));
ipcMain.handle('group:delete', sync((_e, name) => instances.deleteGroup(name)));
ipcMain.handle('group:set', sync((_e, ids, name) => instances.setGroup(ids, name)));
ipcMain.handle('cred:get', sync((_e, id) => instances.getCred(id)));
ipcMain.handle('cred:set', sync((_e, id, cred) => instances.setCred(id, cred)));

/* ---- the click recorder ----------------------------------------------------
 * `opts.from` is how a script recorded on the original runs on a clone.
 * -------------------------------------------------------------------------- */
ipcMain.handle('game:click', asyncOk((_e, id, cmd, opts) => recorder.command(id, cmd, instances.recorderCfg(), opts)));
ipcMain.handle('rec:sources', sync(() => ({
  ok: true,
  ids: recorder.withRecordings(instances.stageData().rows.map((r) => r.id)),
})));

/* ---- dashboard ------------------------------------------------------------- */
ipcMain.handle('stage:open', sync(() => openStage()));
ipcMain.handle('stage:close', sync(() => {
  if (stageWindow && !stageWindow.isDestroyed()) stageWindow.close();
  return { ok: true };
}));
ipcMain.handle('stage:data', sync(() => instances.stageData()));
ipcMain.handle('stage:metrics', asyncOk(() => instances.metrics()));

// One PNG frame for a tile. The renderer turns it into a blob URL; sending the
// buffer straight across avoids a base64 round-trip per frame per instance.
ipcMain.handle('stage:frame', asyncOk(async (_e, id) => {
  const buf = await instances.frame(id);
  if (!buf) return { ok: false };
  return { ok: true, png: buf, status: instances.statusOf(id) };
}));

ipcMain.handle('stage:tap', asyncOk((_e, id, nx, ny) => instances.tapNorm(id, nx, ny)));
ipcMain.handle('stage:swipe', asyncOk((_e, id, x1, y1, x2, y2, ms) => instances.swipeNorm(id, x1, y1, x2, y2, ms)));
ipcMain.handle('stage:key', asyncOk((_e, id, code) => instances.key(id, code)));
ipcMain.handle('stage:text', asyncOk((_e, id, text) => instances.typeText(id, text)));

/* ---- code updates ---------------------------------------------------------- */
ipcMain.handle('update:check', asyncOk(() => updater.check(true)));
ipcMain.handle('update:status', sync(() => ({ ok: true, ...updater.status(), cfg: updater.loadCfg() })));
ipcMain.handle('update:saveConfig', sync((_e, patch) => ({ ok: true, cfg: updater.saveCfg(patch) })));

/* Restart to run code that has already been downloaded.
 *
 * This is awaited rather than fired and forgotten: if the relaunch cannot be
 * arranged, the UI has to say so. Clicking Restart and having nothing at all
 * happen is the worst of the three outcomes.
 */
ipcMain.handle('update:restart', asyncOk(async () => {
  const r = updater.prepareRestart();
  if (!r.ok) return r;
  // Quit on the next tick so this reply reaches the window first.
  setTimeout(() => {
    recorder.stopAll();
    instances.stopWatchdog();
    instances.stopAllNow()
      .catch(() => {})
      .then(() => { quitting = true; app.relaunch(r.relaunch); app.exit(0); });
  }, 150);
  return { ok: true, note: 'Shutting the guests down, then restarting.' };
}));

ipcMain.handle('app:version', sync(() => ({ ok: true, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome })));
ipcMain.handle('app:openExternal', sync((_e, url) => { shell.openExternal(String(url || '')); return { ok: true }; }));
