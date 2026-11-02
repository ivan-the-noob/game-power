/* ===========================================================================
 * Game Power — the instances themselves.
 *
 * Third engine, same model: ONE original you set up by hand, and every other
 * instance a copy of it. What changed is what an instance is made of.
 *
 *   browser  a Chromium window per instance   ~250 MB, kept losing its WebGL
 *                                             context and dropping to login
 *   Android  a whole emulated phone           ~2.7 GB measured, and the game
 *                                             has no Android build at all
 *   now      the game's own Windows client     no emulator, no browser
 *
 * The install is 10.46 GB but only 14 MB of it is per-instance: the packed
 * data (8.96 GB) and the asset folders are shared through hard links and
 * junctions, and only the files the game WRITES are copied. Measured: an
 * instance is built in 37 ms and costs 14.0 MB.
 *
 * Each instance has its own Sevenhearts.ini, which is where the cost of
 * running one is actually decided — resolution, frame cap, glow, water and
 * sound are all in there.
 * ======================================================================== */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const winclient = require('./winclient');
const winapi = require('./winapi');
const procstat = require('./procstat');
const recorder = require('./recorder');
const diskinfo = require('./diskinfo');

const ORIGINAL_ID = 1;

const DEFAULTS = {
  // Where the game is installed. Everything is built from this, and it is
  // never written to.
  gamePath: '',
  exeName: '',            // detected from gamePath

  // Per-instance client settings, written into its own Sevenhearts.ini.
  // These are the knobs that decide what one instance costs.
  width: 800,
  height: 600,
  fullscreen: false,
  fpsLimit: 30,           // the install shipped 240
  muteAll: true,          // no audio device, no mixing, no sound buffers
  glowQuality: 0,
  waterQuality: 0,
  shadowQuality: 0,
  antialias: 0,
  runInBackground: true,  // an unfocused instance must keep playing

  // Dashboard
  tileFps: 2,
  zoomFps: 10,

  // Click recorder playback (unchanged names, so the UI carries over)
  recLoops: 0,
  recLoopGapMin: 0,
  recLoopGap: 1,
  recSpeed: 1,
  recFixedGap: 0,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// id -> { id, child, pid, startedAt, status, note, exe }
const live = new Map();
let state = null;

/* ---- stored state (userData/game.json) ----------------------------------- */
const statePath = () => path.join(app.getPath('userData'), 'game.json');
const clientsRoot = () => path.join(app.getPath('userData'), 'clients');
const clientDir = (id) => path.join(clientsRoot(), String(Number(id)));

let ready = false;
function ensureDirs() {
  if (ready) return;
  try { fs.mkdirSync(clientsRoot(), { recursive: true }); } catch (e) { /* ignore */ }
  recorder.configure({ dir: path.join(app.getPath('userData'), 'recordings') });
  ready = true;
}

/* Each previous engine left settings behind that mean nothing here, and an
 * instance list whose contents cannot be carried over: a browser session and
 * an Android disk image are both useless to a Windows client. The names,
 * groups and saved logins are hand-typed and worth keeping; everything else
 * is dropped, and the user is told once rather than left guessing. */
const FOREIGN_KEYS = ['phoneMode', 'fps', 'dpr', 'muted', 'ram', 'cores', 'gpu', 'dpi', 'diskMB', 'headless', 'trim', 'kiosk', 'pkg', 'url'];
let migrationNote = '';

function loadState() {
  if (state) return state;
  ensureDirs();
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch (e) { raw = {}; }

  const incoming = { ...(raw.settings || {}) };
  const prior = raw.engine && raw.engine !== 'windows' ? raw.engine : (FOREIGN_KEYS.some((k) => k in incoming) ? 'a previous engine' : '');
  for (const k of FOREIGN_KEYS) delete incoming[k];

  state = {
    engine: 'windows',
    settings: { ...DEFAULTS, ...incoming },
    groups: Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g === 'string' && g.trim()) : [],
    list: Array.isArray(raw.list) ? raw.list.filter((i) => i && Number(i.id)) : [],
  };

  if (prior) {
    const n = state.list.length;
    migrationNote = `Game Power now runs the game's own Windows client. The ${n} instance${n === 1 ? '' : 's'} from ${prior === 'android' ? 'the Android version' : 'the previous version'} cannot carry over — names, groups and saved details were kept, but each one needs building again. Point it at your game folder and start the original.`;
  }

  if (!state.list.some((i) => Number(i.id) === ORIGINAL_ID)) {
    state.list.unshift({ id: ORIGINAL_ID, name: 'Original', from: null, createdAt: Date.now() });
  }
  state.list.sort((a, b) => a.id - b.id);

  // Remember where the game is, if we can find it without being told.
  if (!state.settings.gamePath) {
    const guess = guessGamePath();
    if (guess) state.settings.gamePath = guess;
  }
  if (state.settings.gamePath && !state.settings.exeName) {
    state.settings.exeName = winclient.findExe(state.settings.gamePath) || '';
  }

  persist();
  return state;
}

// The usual places a downloaded client ends up, so the first run is not a
// file-picker.
function guessGamePath() {
  const home = os.homedir();
  const roots = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), 'C:/Games', 'D:/Games'];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const a = path.join(root, e.name);
      if (winclient.findExe(a)) return a;
      // Installers often nest one level: Downloads/Game-v1/Game-v1/
      let inner = [];
      try { inner = fs.readdirSync(a, { withFileTypes: true }); } catch (x) { continue; }
      for (const i of inner) {
        if (!i.isDirectory()) continue;
        const b = path.join(a, i.name);
        if (winclient.findExe(b)) return b;
      }
    }
  }
  return null;
}

function takeMigrationNote() {
  const n = migrationNote;
  migrationNote = '';
  return n;
}

function persist() {
  try { fs.writeFileSync(statePath(), JSON.stringify(loadState(), null, 2)); } catch (e) { /* ignore */ }
}

function saveSettings(patch) {
  const next = { ...loadState().settings, ...(patch || {}) };
  next.gamePath = String(next.gamePath || '').trim();
  next.exeName = String(next.exeName || '').trim() || (winclient.findExe(next.gamePath) || '');
  next.width = clamp(parseInt(next.width, 10) || 800, 640, 3840);
  next.height = clamp(parseInt(next.height, 10) || 600, 480, 2160);
  next.fullscreen = !!next.fullscreen;
  next.fpsLimit = clamp(parseInt(next.fpsLimit, 10) || 30, 10, 240);
  next.muteAll = !!next.muteAll;
  next.glowQuality = clamp(parseInt(next.glowQuality, 10) || 0, 0, 2);
  next.waterQuality = clamp(parseInt(next.waterQuality, 10) || 0, 0, 2);
  next.shadowQuality = clamp(parseInt(next.shadowQuality, 10) || 0, 0, 2);
  next.antialias = clamp(parseInt(next.antialias, 10) || 0, 0, 1);
  next.runInBackground = !!next.runInBackground;
  next.tileFps = clamp(Number(next.tileFps) || 2, 0.2, 15);
  next.zoomFps = clamp(Number(next.zoomFps) || 10, 1, 30);
  next.recLoops = clamp(parseInt(next.recLoops, 10) || 0, 0, 100000);
  next.recLoopGapMin = clamp(Number(next.recLoopGapMin) || 0, 0, 600);
  next.recLoopGap = clamp(Number(next.recLoopGap) || 0, 0, 600);
  next.recSpeed = clamp(Number(next.recSpeed) || 1, 0.1, 10);
  next.recFixedGap = clamp(Number(next.recFixedGap) || 0, 0, 600);
  state.settings = next;
  persist();
  return next;
}

const getSettings = () => loadState().settings;
const entry = (id) => loadState().list.find((i) => Number(i.id) === Number(id)) || null;
const nextId = () => Math.max(0, ...loadState().list.map((i) => Number(i.id))) + 1;

/* ---- groups -------------------------------------------------------------- */
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

/* ---- credentials -------------------------------------------------------- */
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

/* ---- readiness ---------------------------------------------------------- */
function health() {
  ensureDirs();
  const s = loadState().settings;
  const info = winclient.inspect(s.gamePath);
  return {
    ok: info.ok,
    gamePath: s.gamePath,
    exe: info.exe || '',
    error: info.error,
    installMB: info.totalMB,
    linkDirs: info.linkDirs,
    bigFiles: info.bigFiles,
    clientsRoot: clientsRoot(),
    migrated: takeMigrationNote(),
  };
}

function setGamePath(dir) {
  const d = String(dir || '').trim();
  const info = winclient.inspect(d);
  if (!info.ok) return { ok: false, error: info.error };
  saveSettings({ gamePath: d, exeName: info.exe });
  return { ok: true, exe: info.exe, installMB: info.totalMB };
}

/* ---- the per-instance client settings ----------------------------------
 * Written into the instance's own Sevenhearts.ini before it starts. This is
 * the whole answer to "make it use less": the client is doing the rendering,
 * so the client's own quality settings are what cost memory and frames.
 * ----------------------------------------------------------------------- */
function applyIni(id) {
  const s = getSettings();
  const ini = path.join(clientDir(id), 'Sevenhearts.ini');
  if (!fs.existsSync(ini)) return false;
  return winclient.patchIni(ini, {
    RESOLUTION: { WIDTH: s.width, HEIGHT: s.height },
    VIDEO: {
      FULLSCREEN: s.fullscreen ? 1 : 0,
      FPSLIMIT: s.fpsLimit,
      ANTIALISING: s.antialias,
      SHADOWQUALITY: s.shadowQuality,
      GLOWQUALITY: s.glowQuality,
      WATERQUALITY: s.waterQuality,
      BLOOM: 0,
      VSYNC: 0,
      // An unfocused client must keep playing, or every instance but the one
      // you are looking at would stall.
      RUNINBACKGROUND: s.runInBackground ? 1 : 0,
    },
    SOUND: { MUTEALL: s.muteAll ? 1 : 0 },
  });
}

/* ---- building and starting ---------------------------------------------- */
const isAlive = (id) => {
  const i = live.get(Number(id));
  return !!(i && (i.status === 'starting' || i.status === 'running'));
};
const statusOf = (id) => { const i = live.get(Number(id)); return i ? i.status : 'stopped'; };
const isBuilt = (id) => fs.existsSync(path.join(clientDir(id), getSettings().exeName || 'x'));

function build(id, fromId) {
  ensureDirs();
  const s = getSettings();
  const info = winclient.inspect(s.gamePath);
  if (!info.ok) return { ok: false, error: info.error };

  const dest = clientDir(id);
  winclient.removeInstance(dest);
  const rep = winclient.buildInstance(s.gamePath, dest);

  // A clone takes the ORIGINAL's own writable files on top of the shared
  // data, so it starts with the same settings and local state rather than the
  // pristine install's.
  if (fromId && Number(fromId) !== Number(id)) {
    const src = clientDir(fromId);
    if (fs.existsSync(src)) inheritWritable(src, dest);
  }
  applyIni(id);
  return { ok: true, report: rep };
}

// Only what the source instance owns: its settings and the folders it writes.
// Never the links — those already point at the same shared data.
function inheritWritable(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    let st = null;
    try { st = fs.lstatSync(from); } catch (x) { continue; }
    if (st.isSymbolicLink()) continue;            // shared asset folder
    if (e.isDirectory()) {
      if (!winclient.OWN_DIRS.includes(e.name)) continue;
      try { fs.rmSync(to, { recursive: true, force: true }); } catch (x) { /* ignore */ }
      copyPlain(from, to);
      continue;
    }
    if (!/\.(ini|cfg|dat|sav)$/i.test(e.name)) continue;
    try { fs.copyFileSync(from, to); } catch (x) { /* ignore */ }
  }
}

function copyPlain(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) { copyPlain(from, to); continue; }
    if (!e.isFile()) continue;
    try { fs.copyFileSync(from, to); } catch (x) { /* ignore */ }
  }
}

function start(id) {
  id = Number(id);
  ensureDirs();
  const row = entry(id);
  if (!row) return { ok: false, error: `Instance #${id} does not exist.` };
  if (isAlive(id)) return { ok: true, already: true };
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };

  const s = getSettings();
  const info = winclient.inspect(s.gamePath);
  if (!info.ok) return { ok: false, error: info.error };

  if (!isBuilt(id)) {
    const b = build(id, null);
    if (!b.ok) return b;
  } else {
    applyIni(id);
  }

  const r = winclient.launch(clientDir(id), s.exeName || info.exe);
  if (!r.ok) return r;

  const inst = { id, child: r.child, pid: r.pid, startedAt: Date.now(), status: 'starting', note: '', exe: r.exe };
  live.set(id, inst);

  r.child.on('exit', (code) => {
    const cur = live.get(id);
    if (!cur || cur.child !== r.child || cur.status === 'stopped') return;
    const secs = Math.round((Date.now() - cur.startedAt) / 1000);
    cur.status = 'error';
    // The usual reason a client vanishes at once is that it will not run a
    // second copy, or it wants its launcher. Say so rather than just "exited".
    cur.note = secs < 10
      ? `Closed itself after ${secs}s (exit ${code}). The client may refuse a second copy, or may need its launcher.`
      : `Exited after ${secs}s (code ${code}).`;
  });

  // Nothing to wait for the way an emulator boots: it either keeps running or
  // it does not. Give it a moment, then say which.
  (async () => {
    await wait(6000);
    const cur = live.get(id);
    if (!cur || cur.child !== r.child || cur.status !== 'starting') return;
    cur.status = 'running';
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
  inst.status = 'stopped';
  const pid = inst.pid;
  if (pid) { try { await procstat.killTree(pid); } catch (e) { /* ignore */ } }
  procstat.forget(pid);
  live.delete(id);
  return { ok: true };
}

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
  return { ok: true };
}

async function reload(id) {
  if (!isAlive(id)) return { ok: false, error: 'That instance is not running.' };
  await stopNow(id);
  await wait(1200);
  return start(id);
}

function rename(id, name) {
  const row = entry(id);
  if (!row) return { ok: false, error: 'No such instance.' };
  row.name = String(name || '').trim().slice(0, 40) || row.name;
  persist();
  return { ok: true };
}

/* ---- cloning ------------------------------------------------------------
 * Nothing is copied but the instance's own settings, so this is instant:
 * measured at 37 ms per instance against a 10.46 GB install.
 * ----------------------------------------------------------------------- */
const cloneState = { busy: false, from: null, newId: null, copied: 0, total: 0, error: '', finishedAt: 0, lastName: '' };

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
  ensureDirs();
  const from = Number(fromId) || ORIGINAL_ID;
  const howMany = clamp(parseInt(count, 10) || 1, 1, 50);
  const src = entry(from);
  if (!src) return { ok: false, error: `Instance #${from} does not exist.` };
  if (!isBuilt(from)) return { ok: false, error: `Instance #${from} has not been built yet. Start it once first — that is what gets copied.` };

  // The source must not be running: its settings file is written on exit, and
  // copying it mid-write would give the clone a torn one.
  await stopNow(from);
  await wait(800);

  cloneState.busy = true;
  cloneState.from = from;
  cloneState.error = '';
  cloneState.copied = 0;
  cloneState.total = howMany;
  cloneState.finishedAt = 0;

  const made = [];
  try {
    for (let k = 0; k < howMany; k += 1) {
      const id = nextId();
      const name = `Clone ${id - 1}`;
      cloneState.newId = id;
      cloneState.lastName = name;
      const b = build(id, from);
      if (!b.ok) throw new Error(b.error);
      loadState().list.push({
        id,
        name,
        from,
        createdAt: Date.now(),
        group: src.group || '',
        cred: src.cred ? { ...src.cred } : undefined,
      });
      persist();
      made.push(id);
      cloneState.copied = made.length;
    }
    cloneState.finishedAt = Date.now();
    return { ok: true, created: made };
  } catch (e) {
    cloneState.error = String(e.message || e);
    return { ok: false, error: cloneState.error, created: made };
  } finally {
    cloneState.busy = false;
    cloneState.newId = null;
  }
}

/* ---- removing ----------------------------------------------------------- */
async function remove(id) {
  id = Number(id);
  if (id === ORIGINAL_ID) return { ok: false, error: 'The original cannot be deleted — clone from it, or reset it instead.' };
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };
  await stopNow(id);
  await wait(600);
  // removeInstance unlinks the junctions first: deleting them recursively
  // would reach through and take the shared install with it.
  winclient.removeInstance(clientDir(id));
  const st = loadState();
  st.list = st.list.filter((i) => Number(i.id) !== id);
  persist();
  return { ok: true };
}

async function reset(id) {
  id = Number(id);
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };
  await stopNow(id);
  await wait(600);
  winclient.removeInstance(clientDir(id));
  return build(id, null);
}

function applyLive(patch) {
  const s = saveSettings(patch);
  // The client reads its settings at startup, so these land on next start.
  for (const row of loadState().list) if (isBuilt(row.id)) applyIni(row.id);
  return { ok: true, settings: s, note: 'Saved. Client settings apply the next time an instance starts.' };
}

function recorderCfg() {
  const s = getSettings();
  return {
    loops: Math.max(0, parseInt(s.recLoops, 10) || 0),
    loopGap: Math.max(0, (Number(s.recLoopGapMin) || 0) * 60 + (Number(s.recLoopGap) || 0)),
    speed: Math.max(0.1, Number(s.recSpeed) || 1),
    fixedGap: Math.max(0, Number(s.recFixedGap) || 0),
  };
}

/* ---- metrics ------------------------------------------------------------ */
let lastSnap = null;
let lastSnapAt = 0;

async function refreshSnapshot() {
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
    const alive = !!inst && (inst.status === 'starting' || inst.status === 'running');
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
      built: isBuilt(row.id),
      alive,
      status: inst ? inst.status : 'stopped',
      note: inst ? inst.note : '',
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
    ready: winclient.inspect(st.settings.gamePath).ok,
  };
}

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
    })),
  };
}

async function diskUsage() {
  ensureDirs();
  const list = loadState().list;
  const dirs = list.map((row) => clientDir(row.id));
  const alloc = await diskinfo.allocatedDirs(dirs).catch(() => ({}));
  const rows = list.map((row, i) => ({
    id: row.id,
    name: row.name,
    mb: Math.round(((alloc[dirs[i]] || 0)) / (1024 * 1024)),
  }));
  return {
    ok: true,
    rows,
    totalMB: rows.reduce((a, r) => a + r.mb, 0),
    freeMB: Math.round(diskinfo.freeBytes(clientsRoot()) / (1024 * 1024)),
    note: 'Shared game data is linked, not copied, so these are the per-instance bytes only.',
  };
}

function tile() {
  return { ok: true, tiled: 0, note: 'The Dashboard is where the instances are shown.' };
}

/* ---- the game's window -------------------------------------------------
 * A client draws into an ordinary desktop window. Finding it is what lets
 * clicks be aimed and lets one instance be told from another.
 *
 * The window is renamed to carry the instance number, for two reasons: the
 * taskbar becomes readable when six are open, and every client otherwise
 * presents the identical title, which makes them impossible to tell apart
 * from the outside.
 * ----------------------------------------------------------------------- */
async function windowOf(id) {
  const inst = live.get(Number(id));
  if (!inst || !inst.pid) return null;
  if (inst.win && inst.win.hwnd) return inst.win;

  const w = await winapi.findWindow(inst.pid).catch(() => null);
  if (!w) return null;                 // still starting: no window drawn yet
  inst.win = w;
  const row = entry(id);
  try { await winapi.setTitle(w.hwnd, `Game Power #${id} — ${(row && row.name) || ''}`); } catch (e) { /* cosmetic */ }
  return w;
}

/* Click inside an instance, in client pixels.
 *
 * Which mechanism is used is a real choice with a real trade-off, documented
 * in winapi.js: a posted message does not steal focus but a game is free to
 * ignore it, while a system mouse event cannot be ignored but takes the
 * foreground. Posted first, because being able to drive instances in the
 * background is the entire point of a wall of them.
 */
async function clickAt(id, x, y, opts) {
  const w = await windowOf(id);
  if (!w) return { ok: false, error: 'That instance has no window yet.' };
  const real = !!(opts && opts.real);
  const r = await winapi.click(w.hwnd, x, y, real);
  if (!r.ok) return { ok: false, error: r.err || 'The click was not accepted.' };
  recorder.noteTap(id, x, y);
  return { ok: true, x: Math.round(x), y: Math.round(y), real };
}

// Click by fraction of the window, so the dashboard need not know its size.
async function clickNorm(id, nx, ny, opts) {
  const w = await windowOf(id);
  if (!w) return { ok: false, error: 'That instance has no window yet.' };
  return clickAt(id, clamp(Number(nx) || 0, 0, 1) * w.w, clamp(Number(ny) || 0, 0, 1) * w.h, opts);
}

async function typeInto(id, text) {
  const w = await windowOf(id);
  if (!w) return { ok: false, error: 'That instance has no window yet.' };
  const r = await winapi.typeText(w.hwnd, text);
  return r.ok ? { ok: true } : { ok: false, error: r.err || 'Could not type into it.' };
}

async function keyInto(id, name) {
  const w = await windowOf(id);
  if (!w) return { ok: false, error: 'That instance has no window yet.' };
  const r = await winapi.key(w.hwnd, name);
  return r.ok ? { ok: true } : { ok: false, error: r.err || 'Could not send that key.' };
}

async function focusWindow(id) {
  const w = await windowOf(id);
  if (!w) return { ok: false, error: 'That instance has no window yet.' };
  await winapi.focusWindow(w.hwnd);
  return { ok: true };
}

/* What the recorder clicks through. Supplied rather than imported so the
 * recorder stays ignorant of the engine behind it. */
const injector = {
  click: (id, x, y) => clickAt(id, x, y),
  surface: async (id) => {
    const w = await windowOf(id);
    return w ? { w: w.w, h: w.h } : null;
  },
};

module.exports = {
  DEFAULTS, ORIGINAL_ID,
  getSettings, saveSettings, applyLive, stageData,
  listGroups, createGroup, deleteGroup, setGroup, getCred, setCred,
  health, setGamePath, takeMigrationNote,
  start, startAll, stop, stopAll, stopNow, stopAllNow, focus, reload, rename, remove, reset,
  build, clientDir, isBuilt, applyIni,
  recorderCfg, statusOf, isAlive, entry,
  windowOf, clickAt, clickNorm, typeInto, keyInto, focusWindow, injector,
  clone, cloneStatus, tile, metrics, diskUsage,
};
