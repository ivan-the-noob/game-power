/* ===========================================================================
 * Game Power — code updates straight from GitHub.
 *
 * On launch the app asks GitHub what is in its repo on the main branch,
 * compares each file against the copy on disk, and downloads only the ones
 * that differ. Reopen the app and you are running the newest code — there is
 * no installer to rebuild and no release to publish.
 *
 * The comparison uses git's own blob hash, which GitHub returns for every
 * file, so "has this changed" needs no version number to be bumped and no
 * manifest to be kept in step.
 *
 * Nothing is written until every changed file has downloaded cleanly: each
 * one lands in a temp file first and is only moved into place at the end, so
 * a dropped connection halfway through cannot leave a half-updated app.
 * ======================================================================== */
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Where to pull from. Overridable per machine in userData/update.json, so a
// private repo can be given a read-only token without that token ever being
// committed, and so the source can be moved without a rebuild.
const DEFAULT_CFG = {
  repo: 'ivan-the-noob/game-power',
  branch: 'main',
  dir: '',            // the app IS the repo now, so its files sit at the root
  token: '',          // only needed while the repo is private
  enabled: true,
};

let cfg = null;

function cfgPath() { return path.join(app.getPath('userData'), 'update.json'); }

function loadCfg() {
  if (cfg) return cfg;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; } catch (e) { raw = {}; }
  cfg = { ...DEFAULT_CFG, ...raw };
  if (!cfg.token && process.env.GAMEPOWER_GH_TOKEN) cfg.token = process.env.GAMEPOWER_GH_TOKEN;
  return cfg;
}

function saveCfg(patch) {
  const next = { ...loadCfg(), ...(patch || {}) };
  next.repo = String(next.repo || DEFAULT_CFG.repo).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  next.branch = String(next.branch || 'main').trim() || 'main';
  // An empty dir is legitimate: it means the repo root, which is where the
  // app's files live now that it has a repo of its own.
  next.dir = String(next.dir == null ? DEFAULT_CFG.dir : next.dir).trim().replace(/^\/+|\/+$/g, '');
  next.token = String(next.token || '').trim();
  next.enabled = next.enabled !== false;
  cfg = next;
  try { fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2)); } catch (e) { /* ignore */ }
  return next;
}

// Only the app's own source. node_modules, build output and local logs are
// not in the repo and must never be touched.
const SYNC_EXT = new Set(['.js', '.html', '.css', '.json', '.md']);
const NEVER = new Set(['package-lock.json', 'npm-install.log']);

const state = { busy: false, lastResult: null };

// git's blob hash, which is what GitHub reports per file.
function blobSha(buf) {
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

function localSha(file) {
  try { return blobSha(fs.readFileSync(file)); } catch (e) { return null; }
}

function headers(extra) {
  const c = loadCfg();
  const h = { 'User-Agent': 'GamePower', ...(extra || {}) };
  if (c.token) h.Authorization = 'Bearer ' + c.token;
  return h;
}

// A 404 from GitHub almost always means the repo is private and we are asking
// without credentials — it answers 404 rather than 403 so private repos stay
// invisible. Say that plainly instead of showing a bare status code.
function explain(status, c) {
  if (status === 404) {
    return c.token
      ? `Not found: check that the token can read ${c.repo}, and that ${c.dir} exists on branch ${c.branch}.`
      : `${c.repo} is private, so updates need a read-only GitHub token (or the code has to live in a public repo).`;
  }
  if (status === 401 || status === 403) return 'GitHub refused the token — it may be expired or lack repo read access.';
  return `GitHub answered ${status}.`;
}

async function getJson(url) {
  const res = await net.fetch(url, { headers: headers({ Accept: 'application/vnd.github+json' }), cache: 'no-store' });
  if (!res.ok) throw new Error(explain(res.status, loadCfg()));
  return res.json();
}

async function getBuffer(url) {
  const res = await net.fetch(url, { headers: headers(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function status() {
  return { busy: state.busy, last: state.lastResult };
}

/* -------------------------------------------------------------------------- */
async function check(apply) {
  if (state.busy) return { ok: false, error: 'A check is already running.' };
  const c = loadCfg();
  if (!c.enabled) return { ok: true, updated: [], upToDate: true, disabled: true };
  state.busy = true;
  try {
    const listing = await getJson(`https://api.github.com/repos/${c.repo}/contents/${c.dir}?ref=${c.branch}`);
    if (!Array.isArray(listing)) throw new Error('Unexpected answer from GitHub.');

    const changed = [];
    for (const item of listing) {
      if (item.type !== 'file') continue;
      if (NEVER.has(item.name)) continue;
      if (!SYNC_EXT.has(path.extname(item.name).toLowerCase())) continue;
      const local = path.join(__dirname, item.name);
      if (localSha(local) !== item.sha) changed.push(item);
    }

    if (!changed.length) {
      state.lastResult = { ok: true, updated: [], at: Date.now(), upToDate: true };
      return state.lastResult;
    }
    if (!apply) {
      state.lastResult = { ok: true, available: changed.map((c) => c.name), at: Date.now() };
      return state.lastResult;
    }

    // Download everything first; only then put any of it in place.
    const staged = [];
    for (const item of changed) {
      const buf = await getBuffer(item.download_url);
      if (blobSha(buf) !== item.sha) throw new Error(`${item.name} arrived corrupted.`);
      const tmp = path.join(__dirname, `.${item.name}.new`);
      fs.writeFileSync(tmp, buf);
      staged.push({ tmp, dest: path.join(__dirname, item.name), name: item.name });
    }
    for (const s of staged) fs.renameSync(s.tmp, s.dest);

    state.lastResult = { ok: true, updated: staged.map((s) => s.name), at: Date.now() };
    return state.lastResult;
  } catch (e) {
    // A failed update is never fatal: the app keeps running the code it has.
    const msg = String(e.message || e);
    state.lastResult = { ok: false, error: msg, at: Date.now() };
    return state.lastResult;
  } finally {
    // Clear any half-downloaded leftovers.
    try {
      for (const f of fs.readdirSync(__dirname)) {
        if (f.startsWith('.') && f.endsWith('.new')) { try { fs.unlinkSync(path.join(__dirname, f)); } catch (e) { /* ignore */ } }
      }
    } catch (e) { /* ignore */ }
    state.busy = false;
  }
}

function restart() {
  app.relaunch();
  app.exit(0);
}

module.exports = { check, status, restart, loadCfg, saveCfg, DEFAULT_CFG };
