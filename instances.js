/* ===========================================================================
 * Game Power — the instances themselves.
 *
 * The model is unchanged from the browser version, because the model was
 * never the problem: there is ONE original you set up by hand, and every
 * other instance is made by CLONING it. A clone starts life with the game
 * already installed and already logged in, because it is a byte copy of the
 * original's Android data partition.
 *
 * What changed is what an instance IS. It used to be a Chromium window on its
 * own session; it is now a real Android guest. That costs far more memory per
 * instance, and buys the thing the browser could not: the game cannot tell it
 * apart from a phone, nothing evicts it the way Chromium evicts an offscreen
 * WebGL context, and input is real kernel input rather than synthetic events
 * an app is free to ignore.
 *
 * An instance runs ONE app and nothing else — see android.trim(). It is
 * headless, so it costs no host display surface at all; the dashboard shows
 * it by pulling frames over ADB.
 * ======================================================================== */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const android = require('./android');
const procstat = require('./procstat');
const recorder = require('./recorder');
const diskinfo = require('./diskinfo');

const GAME_URL = 'https://web.qqirose.com/';
const ORIGINAL_ID = 1;

const DEFAULTS = {
  // Where the original gets the game from: opened in the guest's own browser
  // so you can download the APK exactly as you would on a phone.
  url: GAME_URL,
  pkg: '',             // the game's package name, once we know it

  // The lowest-RAM/GPU knobs. These are the whole point of the rebuild, so
  // they are settings rather than constants.
  ram: 1024,           // MB of guest RAM. Below ~768 Android itself thrashes.
  cores: 1,
  gpu: 'host',         // hardware GL. 'swiftshader_indirect' uses no GPU but measured ~800 MB more.
  /* Which Android to run. This is the biggest single lever on memory:
   * with google_apis the emulator refused a 1024 MB guest and forced 2048
   * (measured in hardware-qemu.ini, and the guest reported MemTotal 1.93 GB),
   * and the Play services run the whole time on top of that. The game is a
   * WebView wrapper with no native code and no Play dependency, so AOSP costs
   * it nothing. Changing this only affects instances built afterwards. */
  imageTag: 'default',
  width: 800,
  height: 480,
  dpi: 160,
  diskMB: 4096,
  headless: true,      // no host window; the dashboard streams frames instead
  trim: true,          // switch off everything in the guest that is not the game
  kiosk: true,         // keep the game in front, relaunch it if it dies

  // Dashboard streaming
  tileFps: 1,          // frames/sec per tile — this is a monitor, not a stream
  zoomFps: 5,          // frames/sec for the one tile you are looking at

  // Click recorder playback (same names as before, so the UI carries over)
  recLoops: 0,         // 0 = keep looping until stopped
  recLoopGapMin: 0,    // minutes of pause between loops
  recLoopGap: 1,       // plus these seconds
  recSpeed: 1,         // multiplies the recorded gaps; 2 = twice as fast
  recFixedGap: 0,      // >0 = ignore the recorded rhythm, use this gap throughout
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// id -> { id, child, pid, serial, startedAt, status, bootedAt, note, screen }
const live = new Map();
let state = null;

/* ---- stored state (userData/game.json) ----------------------------------- */
function statePath() { return path.join(app.getPath('userData'), 'game.json'); }

// AVDs live in our own data folder, never in the user's ~/.android, so
// removing an instance can never damage their own SDK setup.
let avdHomeReady = false;
function ensureAvdHome() {
  if (avdHomeReady) return;
  const dir = path.join(app.getPath('userData'), 'avd');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  android.setAvdHome(dir);
  // The stored image choice has to reach android.js before anything asks it
  // where the system image is. Read straight from the file rather than through
  // getSettings(), which would call back into here.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'game.json'), 'utf8'));
    if (raw && raw.settings && raw.settings.imageTag) android.setTag(raw.settings.imageTag);
  } catch (e) { /* first run: the default stands */ }
  recorder.configure({ dir: path.join(app.getPath('userData'), 'recordings') });
  avdHomeReady = true;
}

/* Coming from the browser version.
 *
 * Its instances were Chromium session folders. There is no converting one of
 * those into an Android disk image, so those instances cannot carry their
 * logins over — but the names, groups and saved credentials are hand-typed
 * data worth keeping, and each row simply has no AVD yet, which start() treats
 * exactly like a brand new instance.
 *
 * Saying so once is the honest thing; silently booting a blank Android where
 * an account used to be is not. */
const BROWSER_ONLY = ['phoneMode', 'fps', 'dpr', 'muted'];
let migratedFrom = '';

function loadState() {
  if (state) return state;
  ensureAvdHome();
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch (e) { raw = {}; }

  const rawSettings = { ...(raw.settings || {}) };
  const cameFromBrowser = raw.engine !== 'android'
    && BROWSER_ONLY.some((k) => Object.prototype.hasOwnProperty.call(rawSettings, k));
  // Drop settings that meant something only to a browser, so they cannot be
  // written back and cannot confuse the settings form.
  for (const k of BROWSER_ONLY) delete rawSettings[k];

  state = {
    engine: 'android',
    settings: { ...DEFAULTS, ...rawSettings },
    groups: Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g === 'string' && g.trim()) : [],
    list: Array.isArray(raw.list) ? raw.list.filter((i) => i && Number(i.id)) : [],
  };

  if (cameFromBrowser) {
    const n = state.list.length;
    // The old rows' app and lineage mean nothing now; everything the user
    // typed stays.
    for (const row of state.list) { row.pkg = ''; }
    migratedFrom = `Game Power now runs real Android instances, so the ${n} instance${n === 1 ? '' : 's'} from the browser version cannot carry ${n === 1 ? 'its' : 'their'} login over — a browser session is not a disk image. Names, groups and saved details were kept. Set the original up again, then clone it.`;
  }

  if (!state.list.some((i) => Number(i.id) === ORIGINAL_ID)) {
    state.list.unshift({ id: ORIGINAL_ID, name: 'Original', from: null, createdAt: Date.now() });
  }
  state.list.sort((a, b) => a.id - b.id);
  persist();
  return state;
}

// Read once by the UI; the stored engine marker means it never fires twice.
function takeMigrationNote() {
  const note = migratedFrom;
  migratedFrom = '';
  return note;
}

function persist() {
  try { fs.writeFileSync(statePath(), JSON.stringify(loadState(), null, 2)); } catch (e) { /* ignore */ }
}

function saveSettings(patch) {
  const next = { ...loadState().settings, ...(patch || {}) };
  next.url = String(next.url || GAME_URL).trim() || GAME_URL;
  if (!/^https?:\/\//i.test(next.url)) next.url = 'https://' + next.url.replace(/^\/+/, '');
  next.pkg = android.cleanPkg(next.pkg);
  next.ram = clamp(parseInt(next.ram, 10) || 1024, 512, 4096);
  next.cores = clamp(parseInt(next.cores, 10) || 1, 1, 4);
  next.gpu = ['swiftshader_indirect', 'host', 'angle_indirect', 'off'].includes(next.gpu) ? next.gpu : 'host';
  // Only offer an image that is actually downloaded, or starting would fail
  // with a missing-image error the user cannot act on.
  const tags = android.installedTags();
  next.imageTag = tags.includes(next.imageTag) ? next.imageTag : (tags[0] || 'default');
  android.setTag(next.imageTag);
  next.width = clamp(parseInt(next.width, 10) || 800, 320, 1920);
  next.height = clamp(parseInt(next.height, 10) || 480, 240, 1080);
  next.dpi = clamp(parseInt(next.dpi, 10) || 160, 120, 480);
  next.diskMB = clamp(parseInt(next.diskMB, 10) || 4096, 2048, 16384);
  next.headless = !!next.headless;
  next.trim = !!next.trim;
  next.kiosk = !!next.kiosk;
  next.tileFps = clamp(Number(next.tileFps) || 1, 0.2, 10);
  next.zoomFps = clamp(Number(next.zoomFps) || 5, 1, 15);
  next.recLoops = clamp(parseInt(next.recLoops, 10) || 0, 0, 100000);
  next.recLoopGapMin = clamp(Number(next.recLoopGapMin) || 0, 0, 600);
  next.recLoopGap = clamp(Number(next.recLoopGap) || 0, 0, 600);
  next.recSpeed = clamp(Number(next.recSpeed) || 1, 0.1, 10);
  next.recFixedGap = clamp(Number(next.recFixedGap) || 0, 0, 600);
  state.settings = next;
  persist();
  return next;
}

function getSettings() { return loadState().settings; }
function entry(id) { return loadState().list.find((i) => Number(i.id) === Number(id)) || null; }
function nextId() { return Math.max(0, ...loadState().list.map((i) => Number(i.id))) + 1; }

/* ---- groups --------------------------------------------------------------
 * A group is a label on an instance plus the list of labels you have made, so
 * an empty group still exists to move things into.
 * -------------------------------------------------------------------------- */
function listGroups() {
  const st = loadState();
  const named = Array.isArray(st.groups) ? st.groups : [];
  const used = st.list.map((i) => (i.group || '').trim()).filter(Boolean);
  return [...new Set([...named, ...used])].sort((a, b) => a.localeCompare(b));
}

function createGroup(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) return { ok: false, error: 'Give the group a name.' };
  const st = loadState();
  if (!Array.isArray(st.groups)) st.groups = [];
  if (st.groups.includes(n)) return { ok: false, error: `"${n}" already exists.` };
  st.groups.push(n);
  persist();
  return { ok: true, groups: listGroups() };
}

function deleteGroup(name) {
  const n = String(name || '').trim();
  const st = loadState();
  st.groups = (Array.isArray(st.groups) ? st.groups : []).filter((g) => g !== n);
  for (const row of st.list) if ((row.group || '') === n) row.group = '';
  persist();
  return { ok: true, groups: listGroups() };
}

function setGroup(ids, name) {
  const n = String(name || '').trim().slice(0, 40);
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean));
  const st = loadState();
  for (const row of st.list) if (want.has(Number(row.id))) row.group = n;
  if (n && Array.isArray(st.groups) && !st.groups.includes(n)) st.groups.push(n);
  persist();
  return { ok: true, groups: listGroups() };
}

/* ---- credentials ---------------------------------------------------------
 * Whatever you need to get back into that account, kept beside the instance
 * it belongs to. Plain text in this app's own data folder — that folder
 * already holds a logged-in Android image, so treat the folder as the secret
 * rather than these fields.
 * -------------------------------------------------------------------------- */
function getCred(id) {
  const row = entry(id);
  return { ok: true, cred: (row && row.cred) || { user: '', pass: '', pin: '', extra: '', note: '' } };
}

function setCred(id, cred) {
  const row = entry(id);
  if (!row) return { ok: false, error: 'No such instance.' };
  const c = cred || {};
  row.cred = {
    user: String(c.user || '').slice(0, 200),
    pass: String(c.pass || '').slice(0, 200),
    pin: String(c.pin || '').slice(0, 64),
    extra: String(c.extra || '').slice(0, 300),
    note: String(c.note || '').slice(0, 1000),
  };
  persist();
  return { ok: true };
}

const hasCred = (row) => !!(row.cred && (row.cred.user || row.cred.pass || row.cred.pin || row.cred.extra || row.cred.note));

/* ---- readiness ----------------------------------------------------------- */
function health() {
  ensureAvdHome();
  loadState();   // so a first-run migration is noticed before the UI asks
  return { ok: true, ...android.health(), avdHome: android.avdHome(), migrated: takeMigrationNote() };
}

function installDeps(onLog) { ensureAvdHome(); return android.installDeps(onLog); }

/* ---- starting an instance ------------------------------------------------ */
const isAlive = (id) => {
  const i = live.get(Number(id));
  return !!(i && i.status !== 'stopped' && i.status !== 'error');
};

function statusOf(id) {
  const i = live.get(Number(id));
  return i ? i.status : 'stopped';
}

function start(id) {
  id = Number(id);
  ensureAvdHome();
  const row = entry(id);
  if (!row) return { ok: false, error: `Instance #${id} does not exist.` };
  if (isAlive(id)) return { ok: true, already: true };
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };

  const h = android.health();
  if (!h.ok) return { ok: false, error: `Android is not set up yet (missing: ${h.missing.join(', ')}). Run "Set up Android" first.` };

  const s = getSettings();
  // The original creates its AVD on first start; a clone already has one, and
  // only needs the resource knobs refreshed.
  if (!android.avdExists(id)) android.writeAvd(id, s);
  else android.tuneAvd(id, s);

  const r = android.startEmu(id, { ...s, window: !s.headless });
  if (!r.ok) return r;

  const inst = {
    id,
    child: r.child,
    pid: r.child.pid,
    serial: r.serial,
    startedAt: Date.now(),
    status: 'booting',
    bootedAt: 0,
    note: '',
    log: r.log,
    screen: null,
  };
  live.set(id, inst);

  r.child.on('exit', () => {
    const cur = live.get(id);
    if (!cur || cur.child !== r.child || cur.status === 'stopped') return;
    // emulator.exe is a launcher: on Windows it can exit while the VM it
    // started keeps running, so its exit alone does not mean we are down.
    procstat.findByCmdline(android.avdName(id)).then((pid) => {
      const still = live.get(id);
      if (!still || still.child !== r.child || still.status === 'stopped') return;
      if (pid) { still.pid = pid; return; }
      still.status = 'error';
      still.note = (r.log.tail.match(/(ERROR|PANIC)[^\n]*/) || ['The emulator exited.'])[0].slice(0, 200);
    }).catch(() => {});
  });

  // Booting takes real time (30-120s cold). Do it off the call so the UI stays
  // responsive, and report progress through the status field.
  (async () => {
    const boot = await android.waitBoot(id, 240000);
    const cur = live.get(id);
    if (!cur || cur.child !== r.child || cur.status === 'stopped') return;
    if (!boot.ok) {
      cur.status = 'error';
      cur.note = boot.error;
      return;
    }
    cur.status = 'ready';
    cur.bootedAt = Date.now();
    try { cur.screen = await android.screenSize(id); } catch (e) { cur.screen = null; }
    if (s.trim) { try { await android.trim(id); } catch (e) { /* best effort */ } }
    const pkg = row.pkg || s.pkg;
    if (pkg) { try { await android.launchApp(id, pkg); } catch (e) { /* ignore */ } }
  })();

  return { ok: true };
}

function startAll() {
  const rows = loadState().list;
  let opened = 0;
  for (const row of rows) {
    if (isAlive(row.id)) continue;
    const r = start(row.id);
    if (r.ok && !r.already) opened += 1;
  }
  return { ok: true, opened, total: rows.length };
}

async function stopNow(id) {
  id = Number(id);
  const inst = live.get(id);
  if (!inst) return { ok: true };

  /* Flush the guest's filesystem BEFORE stopping the machine.
   *
   * `adb emu kill` stops the VM; it does not ask Android to shut down, so
   * anything still in the guest's page cache goes with it. Measured: a file
   * written and read back correctly was gone after a restart unless `sync`
   * ran first — which is to say the login, the downloaded game, and
   * everything a clone exists to inherit.
   *
   * `bootedAt` rather than the status field on purpose: stop() marks the
   * instance stopped before calling this, so the status cannot be used to
   * decide whether there is anything worth flushing. */
  const everReady = inst.bootedAt > 0;
  inst.status = 'stopped';
  if (everReady) {
    try {
      if ((await android.bootState(id)) === 'booted') await android.flush(id);
    } catch (e) { /* best effort — a guest that will not answer cannot be flushed */ }
  }
  try { await android.killEmu(id); } catch (e) { /* ignore */ }
  for (let i = 0; i < 20; i += 1) {
    if ((await android.bootState(id)) === 'offline') break;
    await wait(500);
  }
  let pid = inst.pid;
  if (!pid) pid = await procstat.findByCmdline(android.avdName(id)).catch(() => null);
  if (pid) { try { await procstat.killTree(pid); } catch (e) { /* ignore */ } }
  procstat.forget(inst.pid);
  live.delete(id);
  return { ok: true };
}

// The synchronous face of stopping, for callers that only need it started.
function stop(id) {
  const inst = live.get(Number(id));
  if (inst) inst.status = 'stopped';
  stopNow(id).catch(() => {});
  return { ok: true };
}

async function stopAllNow() {
  await Promise.all([...live.keys()].map((id) => stopNow(id).catch(() => {})));
  return { ok: true };
}

function stopAll() {
  for (const inst of live.values()) inst.status = 'stopped';
  stopAllNow().catch(() => {});
  return { ok: true };
}

function focus(id) {
  if (!isAlive(id)) return { ok: false, error: 'That instance is not running.' };
  return { ok: true, note: 'Instances are headless — open the Dashboard to see them.' };
}

// "Reload" means put the game back in front from scratch, the equivalent of
// reloading the page in the browser version.
async function reload(id) {
  if (!isAlive(id)) return { ok: false, error: 'That instance is not running.' };
  const row = entry(id);
  const pkg = (row && row.pkg) || getSettings().pkg;
  if (!pkg) return { ok: false, error: 'No app is set for this instance yet.' };
  await android.sh(id, `am force-stop ${android.cleanPkg(pkg)}`);
  await android.launchApp(id, pkg);
  return { ok: true };
}

function rename(id, name) {
  const row = entry(id);
  if (!row) return { ok: false, error: 'No such instance.' };
  row.name = String(name || '').trim().slice(0, 40) || row.name;
  persist();
  return { ok: true };
}

/* ---- the one app ---------------------------------------------------------
 * The original gets the game by downloading it the way a phone would. Once it
 * is installed we remember its package name, and every clone inherits that
 * along with the data partition.
 * -------------------------------------------------------------------------- */
async function openGameSite(id, url) {
  if (statusOf(id) !== 'ready') return { ok: false, error: 'Start that instance and wait for it to be ready.' };
  const r = await android.openUrl(id, String(url || getSettings().url));
  return r.ok ? { ok: true } : { ok: false, error: r.err || 'Could not open the browser.' };
}

async function installApk(id, apkPath) {
  if (statusOf(id) !== 'ready') return { ok: false, error: 'Start that instance and wait for it to be ready.' };
  const before = new Set(await android.listApps(id));
  const r = await android.installApk(id, apkPath);
  if (!r.ok) return r;
  // Whatever appeared is the game. That saves asking for a package name the
  // user has no way of knowing.
  const after = await android.listApps(id);
  const fresh = after.filter((p) => !before.has(p));
  const pkg = fresh[0] || '';
  if (pkg) setPkg(id, pkg);
  return { ok: true, pkg };
}

function setPkg(id, pkg) {
  const row = entry(id);
  if (!row) return { ok: false, error: 'No such instance.' };
  row.pkg = android.cleanPkg(pkg);
  // The original's app is *the* app, so it becomes the default for clones.
  if (Number(id) === ORIGINAL_ID && row.pkg) saveSettings({ pkg: row.pkg });
  persist();
  return { ok: true, pkg: row.pkg };
}

async function listApps(id) {
  if (statusOf(id) !== 'ready') return { ok: false, error: 'That instance is not ready yet.' };
  return { ok: true, apps: await android.listApps(id) };
}

async function launchApp(id, pkg) {
  if (statusOf(id) !== 'ready') return { ok: false, error: 'That instance is not ready yet.' };
  const p = android.cleanPkg(pkg || (entry(id) || {}).pkg || getSettings().pkg);
  if (!p) return { ok: false, error: 'No app set yet.' };
  await android.launchApp(id, p);
  return { ok: true };
}

/* ---- the kiosk watchdog --------------------------------------------------
 * ONE timer for all instances, not one per instance: the browser version
 * taught that per-instance timers are how a long-running app grows without
 * anyone noticing.
 * -------------------------------------------------------------------------- */
let watchdog = null;
let watchTick = 0;
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(async () => {
    const s = getSettings();
    watchTick += 1;
    // Flush every fourth tick — once a minute. A clean stop flushes anyway,
    // but a crash, a power cut or Task Manager does not, and an hour of
    // progress sitting unflushed in a guest's page cache is a real loss.
    const alsoFlush = watchTick % 4 === 0;

    for (const inst of [...live.values()]) {
      if (inst.status !== 'ready') continue;
      if (alsoFlush) {
        try { await android.flush(inst.id); } catch (e) { /* ignore */ }
      }
      if (!s.kiosk) continue;
      const row = entry(inst.id);
      const pkg = (row && row.pkg) || s.pkg;
      if (!pkg) continue;
      try {
        const front = await android.foregroundPkg(inst.id);
        if (front && front !== pkg) await android.launchApp(inst.id, pkg);
      } catch (e) { /* a busy guest is not an error */ }
    }
  }, 15000);
  if (watchdog.unref) watchdog.unref();
}

function stopWatchdog() {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
}

/* ---- screen + input ------------------------------------------------------ */
async function frame(id) {
  if (statusOf(id) !== 'ready') return null;
  return android.frame(id);
}

async function screenOf(id) {
  const inst = live.get(Number(id));
  if (inst && inst.screen) return inst.screen;
  const sz = await android.screenSize(id).catch(() => null);
  if (inst && sz) inst.screen = sz;
  return sz;
}

// The dashboard knows where you clicked inside a tile as a fraction of its
// size; only here do we know what that is in device pixels.
async function tapNorm(id, nx, ny) {
  if (statusOf(id) !== 'ready') return { ok: false, error: 'That instance is not ready.' };
  const sz = await screenOf(id);
  if (!sz) return { ok: false, error: 'Could not read the screen size.' };
  const x = clamp(Number(nx) || 0, 0, 1) * sz.w;
  const y = clamp(Number(ny) || 0, 0, 1) * sz.h;
  await android.tap(id, x, y);
  // If this instance is recording, the tap it just received is a step. Noting
  // it here rather than in the UI means a recording can only ever contain taps
  // the guest actually got.
  recorder.noteTap(id, x, y);
  return { ok: true, x: Math.round(x), y: Math.round(y) };
}

async function swipeNorm(id, x1, y1, x2, y2, ms) {
  if (statusOf(id) !== 'ready') return { ok: false, error: 'That instance is not ready.' };
  const sz = await screenOf(id);
  if (!sz) return { ok: false, error: 'Could not read the screen size.' };
  await android.swipe(id, clamp(x1, 0, 1) * sz.w, clamp(y1, 0, 1) * sz.h, clamp(x2, 0, 1) * sz.w, clamp(y2, 0, 1) * sz.h, ms);
  return { ok: true };
}

const key = (id, code) => android.key(id, code);
const typeText = (id, text) => android.typeText(id, text);

/* ---- cloning -------------------------------------------------------------
 * A clone is a byte copy of the original's AVD folder, which is to say of its
 * whole Android data partition: the installed game, its downloaded assets,
 * and the account already logged into it. That is the entire reason the
 * original exists.
 *
 * The source must be shut down first. Copying a running guest's disk image
 * gives you a torn one, and a torn data partition is a lost account.
 * -------------------------------------------------------------------------- */
const cloneState = { busy: false, from: null, newId: null, copied: 0, total: 0, error: '', finishedAt: 0, lastName: '' };

// What must NOT travel with a clone: locks held by the source, and the
// generated configs carrying the source's own absolute paths. The emulator
// rebuilds those from config.ini on first start. cache.img is dropped too —
// it is rebuilt on boot, so copying it is gigabytes for nothing.
const SKIP = new Set(['hardware-qemu.ini', 'emulator-user.ini', 'snapshots', 'cache.img', 'cache.img.qcow2',
  // A dump of guest RAM, not of the disk. Worthless to a clone, and 2 GB of it.
  'ram.img', 'ram.img.qcow2']);
const skipName = (n) => SKIP.has(n) || n.endsWith('.lock') || n.endsWith('.tmp');

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) { try { total += fs.statSync(p).size; } catch (err) { /* ignore */ } }
  }
  return total;
}

function copyableSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    if (skipName(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += copyableSize(p);
    else if (e.isFile()) { try { total += fs.statSync(p).size; } catch (err) { /* ignore */ } }
  }
  return total;
}

/* Copy one AVD folder.
 *
 * Two things here were learned the hard way, by a clone that reported success
 * and then would not boot:
 *
 *  - The copy must preserve holes. fs.copyFileSync writes real zeros, so the
 *    6 GB data partition that occupies 2.4 GB needed 6 GB, ran the disk out
 *    mid-copy, and left the clone without the one file that matters.
 *
 *  - A failed copy must NOT be shrugged off. The old code swallowed the error
 *    "because a lock we cannot read is not worth failing the clone over",
 *    which is exactly backwards: a clone missing its data partition is worth
 *    failing over, loudly.
 *
 * Failures are collected rather than thrown so one unreadable leftover does
 * not hide the state of everything else; clone() decides what is fatal. */
async function copyDir(src, dest, onBytes, failures) {
  fs.mkdirSync(dest, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (e) { failures.push({ name: path.basename(src), error: String(e.message || e) }); return; }

  for (const e of entries) {
    if (skipName(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) { await copyDir(from, to, onBytes, failures); continue; }
    if (!e.isFile()) continue;

    // The source has only just shut down, and Windows can hold a handle on a
    // multi-gigabyte image a moment longer than the guest does.
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await diskinfo.copySparse(from, to, onBytes);
        last = null;
        break;
      } catch (err) {
        last = err;
        try { fs.rmSync(to, { force: true }); } catch (x) { /* ignore */ }
        if (attempt < 2) await wait(1500 * (attempt + 1));
      }
    }
    if (last) failures.push({ name: e.name, error: `${last.code || ''} ${last.message || last}`.trim() });
  }
}

/* Is the copy actually complete?
 *
 * Every file that should have travelled must exist at the same length. This
 * is the check that would have caught the missing data partition instead of
 * letting a broken clone sit in the list looking fine. */
function verifyCopy(src, dest) {
  const missing = [];
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return ['(could not read the source)']; }
  for (const e of entries) {
    if (skipName(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) { missing.push(...verifyCopy(from, to)); continue; }
    if (!e.isFile()) continue;
    let want = 0;
    try { want = fs.statSync(from).size; } catch (err) { continue; }
    let got = -1;
    try { got = fs.statSync(to).size; } catch (err) { got = -1; }
    if (got !== want) missing.push(`${e.name} (${got < 0 ? 'not copied' : `${got} of ${want} bytes`})`);
  }
  return missing;
}

const freeBytes = () => diskinfo.freeBytes(android.avdHome());

// What a clone will REALLY take on disk. The data partition is sparse: a fresh
// instance reports 8.6 GB by file length while occupying 2.5 GB, so the length
// would refuse clones that fit perfectly well.
async function allocatedOf(dir) {
  const got = await diskinfo.allocatedDirs([dir]).catch(() => null);
  return (got && got[dir]) || 0;
}

function cloneStatus() {
  return {
    busy: cloneState.busy,
    from: cloneState.from,
    newId: cloneState.newId,
    name: cloneState.lastName,
    done: cloneState.total ? Math.min(100, Math.round((cloneState.copied / cloneState.total) * 100)) : 0,
    copiedMB: Math.round(cloneState.copied / (1024 * 1024)),
    totalMB: Math.round(cloneState.total / (1024 * 1024)),
    error: cloneState.error,
    finishedAt: cloneState.finishedAt,
  };
}

async function clone(fromId, count) {
  if (cloneState.busy) return { ok: false, error: 'A clone is already running.' };
  ensureAvdHome();
  const from = Number(fromId) || ORIGINAL_ID;
  const howMany = clamp(parseInt(count, 10) || 1, 1, 30);
  const src = entry(from);
  if (!src) return { ok: false, error: `Instance #${from} does not exist.` };

  const srcDir = android.avdDir(from);
  if (!android.avdExists(from)) {
    return { ok: false, error: `Instance #${from} has no Android image yet. Start it, download and install the game first — that is what gets copied.` };
  }
  if (!fs.existsSync(path.join(srcDir, 'userdata-qemu.img'))) {
    return { ok: false, error: `Instance #${from} has never finished booting, so there is nothing to copy yet. Start it and wait for "ready".` };
  }

  // Two different sizes, on purpose. The space check needs what a clone will
  // really occupy (sparse-aware); the progress bar needs the number of bytes
  // the copy loop will actually push, which is the file lengths.
  const mb = (n) => Math.round(n / (1024 * 1024));
  const logicalOne = copyableSize(srcDir);
  const realOne = (await allocatedOf(srcDir)) || logicalOne;
  const need = realOne * howMany;
  const free = freeBytes();
  // Leave the machine half a gig: filling the system disk completely is worse
  // than refusing the clone.
  if (free && need > free - (512 * 1024 * 1024)) {
    const fits = Math.max(0, Math.floor((free - (512 * 1024 * 1024)) / Math.max(1, realOne)));
    return {
      ok: false,
      error: `Not enough disk space. ${howMany} clone${howMany === 1 ? '' : 's'} need about ${mb(need)} MB and only ${mb(free)} MB is free`
        + (fits > 0 ? ` — you have room for ${fits} right now.` : '. Free some space first.'),
    };
  }

  await stopNow(from);
  await wait(2000);   // let the file handles go

  cloneState.busy = true;
  cloneState.from = from;
  cloneState.error = '';
  cloneState.copied = 0;
  cloneState.newId = null;
  cloneState.finishedAt = 0;
  cloneState.total = logicalOne * howMany;

  const made = [];
  try {
    for (let k = 0; k < howMany; k += 1) {
      const id = nextId();
      if (id > android.maxInstances) throw new Error(`No console port left above instance #${android.maxInstances}.`);
      const name = `Clone ${id - 1}`;
      cloneState.newId = id;
      cloneState.lastName = name;
      const dest = android.avdDir(id);
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }

      const failures = [];
      await copyDir(srcDir, dest, (b) => { cloneState.copied += b; }, failures);

      // Never leave a clone that looks fine and has no data partition. If
      // anything is short or missing, throw the copy away rather than add it
      // to the list — a broken clone is worse than no clone.
      const missing = verifyCopy(srcDir, dest);
      if (failures.length || missing.length) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmSync(android.avdIni(id), { force: true }); } catch (e) { /* ignore */ }
        const why = failures.length
          ? failures.map((f) => `${f.name}: ${f.error}`).join('; ')
          : `incomplete: ${missing.join(', ')}`;
        throw new Error(`The copy did not finish, so the clone was discarded — ${why}`);
      }

      // The copy still calls itself by the source's name and points at the
      // source's folder. This is what makes it its own instance.
      android.retargetAvd(id, getSettings());
      loadState().list.push({
        id,
        name,
        from,
        createdAt: Date.now(),
        // Everything the original knew, the clone knows.
        pkg: src.pkg || getSettings().pkg || '',
        group: src.group || '',
        cred: src.cred ? { ...src.cred } : undefined,
      });
      persist();
      made.push(id);
    }
    cloneState.finishedAt = Date.now();
    return { ok: true, created: made, mb: Math.round(cloneState.copied / (1024 * 1024)) };
  } catch (e) {
    cloneState.error = String(e.message || e);
    return { ok: false, error: cloneState.error, created: made };
  } finally {
    cloneState.busy = false;
    cloneState.newId = null;
  }
}

/* ---- removing ------------------------------------------------------------ */
async function remove(id) {
  id = Number(id);
  if (id === ORIGINAL_ID) return { ok: false, error: 'The original cannot be deleted — clone from it, or reset it instead.' };
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };
  await stopNow(id);
  await wait(1200);
  android.deleteAvd(id);
  const st = loadState();
  st.list = st.list.filter((i) => Number(i.id) !== id);
  persist();
  return { ok: true };
}

// Wipe one instance back to a fresh Android, keeping it in the list.
async function reset(id) {
  id = Number(id);
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };
  await stopNow(id);
  await wait(1200);
  android.deleteAvd(id);
  android.writeAvd(id, getSettings());
  const row = entry(id);
  if (row) { row.pkg = ''; persist(); }
  return { ok: true };
}

function applyLive(patch) {
  const s = saveSettings(patch);
  // You cannot re-RAM a running VM, so resource changes land on next start.
  for (const inst of live.values()) {
    if (inst.status === 'ready') android.tuneAvd(inst.id, s);
  }
  return { ok: true, settings: s, note: 'Saved. RAM, cores, graphics and screen size apply the next time an instance starts.' };
}

function recorderCfg() {
  const s = getSettings();
  return {
    loops: Math.max(0, parseInt(s.recLoops, 10) || 0),
    // Minutes and seconds add up, so "5 minutes" is one field away.
    loopGap: Math.max(0, (Number(s.recLoopGapMin) || 0) * 60 + (Number(s.recLoopGap) || 0)),
    speed: Math.max(0.1, Number(s.recSpeed) || 1),
    fixedGap: Math.max(0, Number(s.recFixedGap) || 0),
  };
}

/* ---- metrics -------------------------------------------------------------
 * One OS snapshot covers every instance. The cost of an instance is its whole
 * process tree, because the guest's RAM lives in the qemu child rather than
 * in the launcher we spawned.
 * -------------------------------------------------------------------------- */
let lastSnap = null;
let lastSnapAt = 0;

async function refreshSnapshot() {
  // More often than this is pointless — a VM's working set does not move that
  // fast, and each snapshot costs a process spawn.
  if (Date.now() - lastSnapAt < 1500) return lastSnap;
  lastSnap = await procstat.snapshot();
  lastSnapAt = Date.now();
  return lastSnap;
}

async function metrics() {
  const st = loadState();
  const snap = await refreshSnapshot();

  const rows = [];
  let instMB = 0;
  for (const row of st.list) {
    const inst = live.get(Number(row.id));
    const alive = !!inst && inst.status !== 'stopped';
    let ramMB = 0;
    let cpu = 0;
    if (alive && snap && inst.pid) {
      const t = procstat.tree(snap, inst.pid);
      ramMB = t.ramMB;
      cpu = t.cpu;
    }
    instMB += ramMB;
    rows.push({
      id: row.id,
      name: row.name,
      group: row.group || '',
      hasCred: hasCred(row),
      original: Number(row.id) === ORIGINAL_ID,
      from: row.from || null,
      pkg: row.pkg || '',
      alive,
      status: inst ? inst.status : 'stopped',
      note: inst ? inst.note : '',
      serial: android.serialFor(row.id),
      ramMB,
      cpu,
      upMin: alive ? Math.max(0, Math.round((Date.now() - inst.startedAt) / 60000)) : 0,
    });
  }

  const running = rows.filter((r) => r.alive).length;
  return {
    ok: true,
    settings: st.settings,
    rows,
    running,
    count: rows.length,
    instancesMB: Math.round(instMB),
    perInstanceMB: running ? Math.round(instMB / running) : 0,
    hostFreeMB: Math.round(os.freemem() / (1024 * 1024)),
    hostTotalMB: Math.round(os.totalmem() / (1024 * 1024)),
    clone: cloneStatus(),
    android: android.health().ok,
  };
}

// What the dashboard needs to build a tile per instance.
function stageData() {
  return {
    ok: true,
    settings: getSettings(),
    groups: listGroups(),
    rows: loadState().list.map((row) => ({
      id: row.id,
      name: row.name,
      group: row.group || '',
      original: Number(row.id) === ORIGINAL_ID,
      pkg: row.pkg || '',
      serial: android.serialFor(row.id),
    })),
  };
}

/* How much disk each instance is actually using.
 *
 * Reports the ALLOCATED size, not the file length: the data partition is
 * sparse, so an instance that looks like 8.6 GB is really 2.5 GB. The scan
 * walks every file, so it is called on demand rather than on the poll. */
async function diskUsage() {
  ensureAvdHome();
  const list = loadState().list;
  const dirs = list.map((row) => android.avdDir(row.id));
  const alloc = await diskinfo.allocatedDirs(dirs).catch(() => ({}));
  const rows = list.map((row, i) => ({
    id: row.id,
    name: row.name,
    mb: Math.round(((alloc[dirs[i]] != null ? alloc[dirs[i]] : dirSize(dirs[i])) || 0) / (1024 * 1024)),
  }));
  return {
    ok: true,
    rows,
    totalMB: rows.reduce((a, r) => a + r.mb, 0),
    freeMB: Math.round(freeBytes() / (1024 * 1024)),
  };
}

// Kept so the control panel's Tile button has something honest to say:
// headless instances have no windows to arrange.
function tile() {
  return { ok: true, tiled: 0, note: 'Instances are headless — the Dashboard is where you see them.' };
}

startWatchdog();

module.exports = {
  GAME_URL, DEFAULTS, ORIGINAL_ID,
  getSettings, saveSettings, applyLive, stageData,
  listGroups, createGroup, deleteGroup, setGroup, getCred, setCred,
  health, installDeps,
  start, startAll, stop, stopAll, stopNow, stopAllNow, focus, reload, rename, remove, reset,
  openGameSite, installApk, listApps, launchApp, setPkg,
  frame, screenOf, tapNorm, swipeNorm, key, typeText,
  recorderCfg, statusOf, isAlive, entry, takeMigrationNote,
  clone, cloneStatus, tile, metrics, diskUsage, stopWatchdog,
};
