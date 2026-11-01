/* ===========================================================================
 * Game Power — the instances themselves.
 *
 * The model is an emulator's: there is ONE original you set up by hand (log
 * in, download the game's asset packs), and every other instance is created
 * by CLONING it. A clone starts life with the packs already on disk, so the
 * multi-gigabyte download happens once instead of once per instance.
 *
 * Why there is no Android in here: QQiROSE is a web game (WebGL + a PWA
 * manifest, no Android app). Under an emulator each instance would carry a
 * whole guest operating system — Windows -> VM -> Android -> Android Chrome
 * -> game — which is where ~1.5-2 GB per instance goes. Here it is
 * Windows -> window -> game, and every instance shares ONE GPU process and
 * ONE network process with all the others.
 *
 * Each instance owns a `persist:rca-game-<id>` session, so it has its own
 * login, cookies and asset cache — the thing multi-instance is actually for.
 *
 * The low-graphics knobs (frame-rate cap, render scale) live in
 * game-preload.js; this file owns the windows, the grid, cloning and metrics.
 * ======================================================================== */
const electron = require('electron');
const path = require('path');
const fs = require('fs');

const { app, BrowserWindow, session } = electron;

const GAME_URL = 'https://web.qqirose.com/';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const ORIGINAL_ID = 1;

const DEFAULTS = {
  url: GAME_URL,
  phoneMode: true,   // mobile identity + portrait windows (the game's lighter layout)
  fps: 20,           // 0 = uncapped
  dpr: 0,            // 0 = native. Lowering it letterboxes games that size their own canvas from devicePixelRatio.
  muted: true,
  // Click recorder playback
  recLoops: 0,       // 0 = keep looping until stopped
  recLoopGapMin: 0,  // minutes of pause between loops
  recLoopGap: 1,     // plus these seconds
  recSpeed: 1,       // multiplies the recorded gaps; 2 = twice as fast
  recFixedGap: 0,    // >0 = ignore the recorded rhythm, use this gap for every click
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// id -> { id, win, startedAt, tuned }
const live = new Map();
let state = null;   // { settings, list: [{ id, name, from, createdAt }] }

/* ---- stored state (userData/game.json) ----------------------------------- */
function statePath() { return path.join(app.getPath('userData'), 'game.json'); }

function loadState() {
  if (state) return state;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch (e) { raw = {}; }
  // The first version of this file kept the settings at the top level, before
  // instances became a list. Carry those over rather than silently resetting.
  const legacy = (!raw.settings && raw.url) ? { url: raw.url, phoneMode: raw.phoneMode, fps: raw.fps, dpr: raw.dpr, muted: raw.muted } : null;
  state = {
    settings: { ...DEFAULTS, ...(raw.settings || legacy || {}) },
    // Group names you have made, kept apart from the instances so an empty
    // group still exists to move things into.
    groups: Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g === 'string' && g.trim()) : [],
    list: Array.isArray(raw.list) ? raw.list.filter((i) => i && Number(i.id)) : [],
  };
  if (!state.list.some((i) => Number(i.id) === ORIGINAL_ID)) {
    state.list.unshift({ id: ORIGINAL_ID, name: 'Original', from: null, createdAt: Date.now() });
  }
  state.list.sort((a, b) => a.id - b.id);
  // Write the migrated / freshly-created shape straight back, so the file on
  // disk always matches what the app is actually using.
  persist();
  return state;
}

function persist() {
  try { fs.writeFileSync(statePath(), JSON.stringify(loadState(), null, 2)); } catch (e) { /* ignore */ }
}

function saveSettings(patch) {
  const s = loadState().settings;
  const next = { ...s, ...(patch || {}) };
  next.url = String(next.url || GAME_URL).trim() || GAME_URL;
  if (!/^https?:\/\//i.test(next.url)) next.url = 'https://' + next.url.replace(/^\/+/, '');
  next.phoneMode = !!next.phoneMode;
  next.muted = !!next.muted;
  next.fps = clamp(parseInt(next.fps, 10) || 0, 0, 120);
  next.dpr = clamp(Number(next.dpr) || 0, 0, 2);
  next.recLoops = clamp(parseInt(next.recLoops, 10) || 0, 0, 100000);
  next.recLoopGapMin = clamp(Number(next.recLoopGapMin) || 0, 0, 600);
  next.recLoopGap = clamp(Number(next.recLoopGap) || 0, 0, 600);
  next.recSpeed = clamp(Number(next.recSpeed) || 1, 0.1, 10);
  next.recFixedGap = clamp(Number(next.recFixedGap) || 0, 0, 600);
  state.settings = next;
  persist();
  return next;
}

/* ---- groups --------------------------------------------------------------
 * A group is just a label on an instance, plus a list of the labels you have
 * made so an empty group can still exist to drag things into. Both the
 * instances table and the dashboard filter on it.
 * -------------------------------------------------------------------------- */
function listGroups() {
  const st = loadState();
  const named = Array.isArray(st.groups) ? st.groups : [];
  // Anything an instance claims counts, even if the list lost it somehow.
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
  // The instances survive; they just lose the label.
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
 * it belongs to. Stored in plain text in this app's own data folder, the same
 * way the browser session beside it already holds a live login — so treat the
 * folder as the secret, not these fields.
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

function getSettings() { return loadState().settings; }
function entry(id) { return loadState().list.find((i) => Number(i.id) === Number(id)) || null; }
function nextId() { return Math.max(0, ...loadState().list.map((i) => Number(i.id))) + 1; }
function partitionDir(id) { return path.join(app.getPath('userData'), 'Partitions', `rca-game-${Number(id)}`); }
const isAlive = (id) => { const i = live.get(Number(id)); return !!(i && i.win && !i.win.isDestroyed()); };

/* ---- the grid ------------------------------------------------------------
 * Pick the column count that gives the biggest window while keeping the
 * instances' shape and fitting the work area — what an emulator's
 * multi-instance manager does when it lays its windows out.
 * -------------------------------------------------------------------------- */
function bestGrid(n, W, H, aspect) {
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const cw = Math.floor(W / cols);
    const ch = Math.floor(H / rows);
    if (cw < 150 || ch < 130) continue;
    const w = Math.max(150, Math.min(cw, Math.floor(ch * aspect)));
    const h = Math.max(130, Math.min(ch, Math.floor(cw / aspect)));
    const score = w * h;
    if (!best || score > best.score) best = { cols, rows, cw, ch, w, h, score };
  }
  if (best) return best;
  // More instances than the screen can hold at a sane size: pack them anyway.
  const cols = Math.ceil(Math.sqrt(n * (W / Math.max(1, H))));
  const rows = Math.ceil(n / cols);
  const cw = Math.max(150, Math.floor(W / cols));
  const ch = Math.max(130, Math.floor(H / rows));
  return { cols, rows, cw, ch, w: cw, h: ch, score: cw * ch };
}

function tile() {
  const open = [...live.values()].filter((i) => i.win && !i.win.isDestroyed()).sort((a, b) => a.id - b.id);
  if (!open.length) return { ok: true, tiled: 0 };
  const s = getSettings();
  const wa = electron.screen.getPrimaryDisplay().workArea;
  // Landscape either way: this game declares orientation "landscape" in its
  // own manifest, so a portrait window just letterboxes it with black.
  const aspect = s.phoneMode ? 16 / 9 : 16 / 10;
  const g = bestGrid(open.length, wa.width, wa.height, aspect);
  open.forEach((inst, i) => {
    const col = i % g.cols;
    const row = Math.floor(i / g.cols);
    try {
      if (inst.win.isMinimized()) inst.win.restore();
      inst.win.setBounds({
        x: wa.x + col * g.cw + Math.floor((g.cw - g.w) / 2),
        y: wa.y + row * g.ch,
        width: g.w,
        height: g.h,
      });
    } catch (e) { /* a window closing mid-tile is fine */ }
  });
  return { ok: true, tiled: open.length, cols: g.cols, rows: g.rows };
}

/* ---- sessions ------------------------------------------------------------
 * Shared by both ways of showing an instance: its own window, and a tile
 * inside the dashboard. Returns the partition name.
 * -------------------------------------------------------------------------- */
function prepareSession(id) {
  const s = getSettings();
  const partition = `persist:rca-game-${Number(id)}`;
  const ses = session.fromPartition(partition);
  try { ses.setSpellCheckerEnabled(false); } catch (e) { /* ignore */ }
  try { ses.setUserAgent(s.phoneMode ? PHONE_UA : session.defaultSession.getUserAgent()); } catch (e) { /* ignore */ }
  // No prompts in a window nobody is watching.
  try {
    ses.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'fullscreen' || permission === 'pointerLock');
    });
  } catch (e) { /* ignore */ }
  return partition;
}

// What the dashboard needs to build a tile per instance.
function stageData() {
  const s = getSettings();
  return {
    ok: true,
    settings: s,
    ua: s.phoneMode ? PHONE_UA : '',
    groups: listGroups(),
    rows: loadState().list.map((row) => ({
      id: row.id,
      name: row.name,
      group: row.group || '',
      original: Number(row.id) === ORIGINAL_ID,
      partition: prepareSession(row.id),
    })),
  };
}

/* ---- starting an instance ------------------------------------------------ */
function start(id) {
  id = Number(id);
  const row = entry(id);
  if (!row) return { ok: false, error: `Instance #${id} does not exist.` };
  if (isAlive(id)) { focus(id); return { ok: true, already: true }; }
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };

  const s = getSettings();
  const partition = prepareSession(id);

  const win = new BrowserWindow({
    // Landscape: the game asks for it in its manifest, and a portrait window
    // leaves most of the frame black.
    width: s.phoneMode ? 640 : 900,
    height: s.phoneMode ? 380 : 580,
    title: `#${id} ${row.name}`,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'game-preload.js'),
      // The preload has to reach the page's own requestAnimationFrame and
      // devicePixelRatio, which is exactly what context isolation prevents.
      // Still sandboxed with no Node integration, so the page gains nothing.
      contextIsolation: false,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
      additionalArguments: [`--rca-fps=${s.fps || 0}`, `--rca-dpr=${s.dpr || 0}`],
    },
  });

  // Keep our own "#id" title: the page would otherwise overwrite it and every
  // window in the grid would read the same.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setAudioMuted(!!s.muted);
  // Popups (ads, OAuth) open in the same window rather than spawning more.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { win.webContents.loadURL(url); } catch (e) { /* ignore */ }
    return { action: 'deny' };
  });
  win.on('closed', () => { live.delete(id); });
  win.once('ready-to-show', () => { try { win.show(); } catch (e) { /* ignore */ } });
  win.loadURL(s.url).catch(() => {});

  const inst = { id, win, startedAt: Date.now(), tuned: null };
  live.set(id, inst);
  // Confirm the low-graphics overrides really landed, rather than assuming.
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript('window.__rcaGameTuned || null', true)
      .then((t) => { inst.tuned = t || null; })
      .catch(() => { inst.tuned = null; });
  });
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
  setTimeout(tile, 900);
  return { ok: true, opened, total: rows.length };
}

function stop(id) {
  const inst = live.get(Number(id));
  if (inst && inst.win && !inst.win.isDestroyed()) inst.win.destroy();
  live.delete(Number(id));
  return { ok: true };
}

function stopAll() {
  for (const inst of [...live.values()]) {
    if (inst.win && !inst.win.isDestroyed()) inst.win.destroy();
  }
  live.clear();
  return { ok: true };
}

function focus(id) {
  const inst = live.get(Number(id));
  if (!inst || !inst.win || inst.win.isDestroyed()) return { ok: false, error: 'That instance is not running.' };
  if (inst.win.isMinimized()) inst.win.restore();
  inst.win.focus();
  return { ok: true };
}

// Click recorder commands for an instance running in its own window. (A
// dashboard tile is a <webview>, so the dashboard talks to its tiles direct.)
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

// Which instance does this renderer belong to? Lets the main process label a
// status report that arrives from inside a game window.
function idForWebContents(wcId) {
  for (const inst of live.values()) {
    try { if (inst.win && !inst.win.isDestroyed() && inst.win.webContents.id === Number(wcId)) return inst.id; }
    catch (e) { /* ignore */ }
  }
  return null;
}

function sendClick(id, msg) {
  const inst = live.get(Number(id));
  if (!inst || !inst.win || inst.win.isDestroyed()) return { ok: false, error: 'Start that instance first.' };
  try { inst.win.webContents.send('rca-game:click', { cfg: recorderCfg(), ...(msg || {}) }); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
}

function reload(id) {
  const inst = live.get(Number(id));
  if (!inst || !inst.win || inst.win.isDestroyed()) return { ok: false, error: 'That instance is not running.' };
  inst.win.webContents.reload();
  return { ok: true };
}

function rename(id, name) {
  const row = entry(id);
  if (!row) return { ok: false, error: 'No such instance.' };
  row.name = String(name || '').trim().slice(0, 40) || row.name;
  persist();
  const inst = live.get(Number(id));
  if (inst && inst.win && !inst.win.isDestroyed()) { try { inst.win.setTitle(`#${id} ${row.name}`); } catch (e) { /* ignore */ } }
  return { ok: true };
}

// Remove a clone entirely: its window, its registry row and its data. The
// original is kept — it is the thing everything else is copied from.
async function remove(id) {
  id = Number(id);
  if (id === ORIGINAL_ID) return { ok: false, error: 'The original cannot be deleted — clone from it, or reset it instead.' };
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };
  stop(id);
  await new Promise((r) => setTimeout(r, 900));   // let Chromium drop its file locks
  try { fs.rmSync(partitionDir(id), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const st = loadState();
  st.list = st.list.filter((i) => Number(i.id) !== id);
  persist();
  return { ok: true };
}

// Wipe one instance back to empty, keeping it in the list.
async function reset(id) {
  id = Number(id);
  if (cloneState.busy) return { ok: false, error: 'A clone is running — wait for it to finish.' };
  stop(id);
  await new Promise((r) => setTimeout(r, 900));
  try { fs.rmSync(partitionDir(id), { recursive: true, force: true }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  return { ok: true };
}

function applyLive(patch) {
  const s = saveSettings(patch);
  for (const inst of live.values()) {
    if (!inst.win || inst.win.isDestroyed()) continue;
    try { inst.win.webContents.setAudioMuted(!!s.muted); } catch (e) { /* ignore */ }
  }
  return { ok: true, settings: s };
}

/* ---- cloning -------------------------------------------------------------
 * Make a new instance that is a copy of an existing one, data and all. This
 * is the whole point: the source has already downloaded the game's asset
 * packs, so the copy starts with them instead of fetching gigabytes again.
 *
 * The source has to be closed first — Chromium holds locks on its storage
 * while it is open, and copying a live database gives you a corrupt one.
 * -------------------------------------------------------------------------- */
const cloneState = { busy: false, from: null, newId: null, copied: 0, total: 0, error: '', finishedAt: 0, lastName: '' };

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

function copyDir(src, dest, onBytes) {
  fs.mkdirSync(dest, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) { copyDir(from, to, onBytes); continue; }
    if (!e.isFile()) continue;   // skip sockets / links Chromium leaves behind
    try {
      fs.copyFileSync(from, to);
      onBytes(fs.statSync(to).size);
    } catch (err) { /* a lock file we cannot read is not worth failing the clone over */ }
  }
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
  const from = Number(fromId) || ORIGINAL_ID;
  const howMany = clamp(parseInt(count, 10) || 1, 1, 30);
  const src = entry(from);
  if (!src) return { ok: false, error: `Instance #${from} does not exist.` };
  const srcDir = partitionDir(from);
  if (!fs.existsSync(srcDir)) {
    return { ok: false, error: `Instance #${from} has no data yet. Start it, log in and download the game first — that is what gets copied.` };
  }

  // The source must not be running while it is read.
  stop(from);

  cloneState.busy = true;
  cloneState.from = from;
  cloneState.error = '';
  cloneState.copied = 0;
  cloneState.newId = null;
  cloneState.finishedAt = 0;

  await new Promise((r) => setTimeout(r, 1500));   // let the file handles go

  const made = [];
  try {
    const one = dirSize(srcDir);
    cloneState.total = one * howMany;
    for (let k = 0; k < howMany; k += 1) {
      const id = nextId();
      const name = `Clone ${id - 1}`;
      cloneState.newId = id;
      cloneState.lastName = name;
      const dest = partitionDir(id);
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      copyDir(srcDir, dest, (b) => { cloneState.copied += b; });
      loadState().list.push({ id, name, from, createdAt: Date.now() });
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

/* ---- metrics -------------------------------------------------------------
 * app.getAppMetrics() is per OS process. Each instance has its own renderer
 * process (its own session partition), so its working set is the honest cost
 * of that instance. GPU / network / browser processes are shared by all of
 * them and reported separately instead of being blamed on any one.
 * -------------------------------------------------------------------------- */
function metrics() {
  const st = loadState();
  let all = [];
  try { all = app.getAppMetrics(); } catch (e) { all = []; }
  const byPid = new Map(all.map((m) => [m.pid, m]));

  const ownPids = new Set();
  const rows = st.list.map((row) => {
    const inst = live.get(Number(row.id));
    const alive = !!(inst && inst.win && !inst.win.isDestroyed());
    let pid = null;
    if (alive) { try { pid = inst.win.webContents.getOSProcessId(); } catch (e) { pid = null; } }
    const m = pid ? byPid.get(pid) : null;
    if (pid) ownPids.add(pid);
    if (alive && m) {
      // The title strip doubles as the live readout, the way an emulator
      // labels its instances.
      try { inst.win.setTitle(`#${row.id} ${row.name} · ${Math.round(m.memory.workingSetSize / 1024)} MB · ${Math.round(m.cpu.percentCPU || 0)}%`); }
      catch (e) { /* ignore */ }
    }
    return {
      id: row.id,
      name: row.name,
      group: row.group || '',
      hasCred: hasCred(row),
      original: Number(row.id) === ORIGINAL_ID,
      from: row.from || null,
      alive,
      ramMB: m ? Math.round(m.memory.workingSetSize / 1024) : 0,
      cpu: m ? Math.round((m.cpu.percentCPU || 0) * 10) / 10 : 0,
      upMin: alive ? Math.max(0, Math.round((Date.now() - inst.startedAt) / 60000)) : 0,
      tuned: alive ? (inst.tuned || null) : null,
    };
  });

  let sharedMB = 0;
  let totalMB = 0;
  for (const m of all) {
    const mb = m.memory.workingSetSize / 1024;
    totalMB += mb;
    if (!ownPids.has(m.pid) && (m.type === 'GPU' || m.type === 'Utility' || m.type === 'Browser')) sharedMB += mb;
  }
  const running = rows.filter((r) => r.alive).length;
  const instMB = rows.reduce((a, r) => a + r.ramMB, 0);

  return {
    ok: true,
    settings: st.settings,
    rows,
    running,
    count: rows.length,
    instancesMB: Math.round(instMB),
    sharedMB: Math.round(sharedMB),
    totalMB: Math.round(totalMB),
    perInstanceMB: running ? Math.round(instMB / running) : 0,
    clone: cloneStatus(),
  };
}

// How much disk each instance is actually using. The scan walks every cached
// file, so it is called on demand rather than on the one-second poll.
function diskUsage() {
  const rows = loadState().list.map((row) => ({
    id: row.id,
    name: row.name,
    mb: Math.round(dirSize(partitionDir(row.id)) / (1024 * 1024)),
  }));
  return { ok: true, rows, totalMB: rows.reduce((a, r) => a + r.mb, 0) };
}

module.exports = {
  GAME_URL, DEFAULTS, ORIGINAL_ID,
  getSettings, saveSettings, applyLive, prepareSession, stageData,
  listGroups, createGroup, deleteGroup, setGroup, getCred, setCred,
  start, startAll, stop, stopAll, focus, reload, rename, remove, reset, sendClick, recorderCfg, idForWebContents,
  clone, cloneStatus, tile, metrics, diskUsage,
};
