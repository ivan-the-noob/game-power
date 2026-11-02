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

/* Never update source that lives in a git working tree.
 *
 * This writes GitHub's copy of a file straight over the local one. That is
 * exactly right for an installed copy and exactly wrong for a checkout: it
 * silently discards uncommitted work, which is as bad for whoever clones this
 * repo to change something as it is for the machine it was written on.
 *
 * An installed build has no .git anywhere above it, so this costs nothing in
 * the case the updater actually exists for. */
function gitWorkingTree() {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

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
  /* A portable build cannot be updated, and pretending otherwise loops.
   *
   * The portable .exe unpacks itself into a NEW temp folder on every launch
   * and deletes it on exit, so files written next to it live only until the
   * app closes. Updating it downloaded the changed files, reported "restart to
   * run the new code", and the restart extracted a clean original copy over
   * the top — so the same files were fetched again, forever, with the version
   * never moving. Observed exactly that: "Updated 8 files", restart, still
   * v4.0.0, "Updated 8 files".
   *
   * Refuse, and say which build to use instead. */
  if (process.env.PORTABLE_EXECUTABLE_FILE && apply) {
    state.lastResult = {
      ok: true,
      updated: [],
      upToDate: true,
      disabled: true,
      error: 'This is the portable build, which unpacks itself again on every launch — an update cannot survive a restart. Install with "Game Power Setup" instead and updates will stick.',
      at: Date.now(),
    };
    return state.lastResult;
  }

  // Writing over a checkout would throw away uncommitted work. Refuse, and say
  // why, rather than appearing to be up to date.
  const tree = gitWorkingTree();
  if (tree && apply) {
    state.lastResult = {
      ok: true,
      updated: [],
      upToDate: true,
      disabled: true,
      error: `Not updating: this copy is a git checkout (${tree}), so pulling would overwrite local changes. Use git here instead.`,
      at: Date.now(),
    };
    return state.lastResult;
  }
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

/* What to relaunch, and whether we even can.
 *
 * `app.relaunch()` with no arguments re-runs process.execPath. For an
 * installed build that is right. For the PORTABLE build it is not: a portable
 * exe unpacks itself into a temp folder and runs from there, and that folder
 * is deleted as the app exits — so the relaunch pointed at something that was
 * about to vanish, and Restart appeared to do nothing at all. The portable
 * launcher puts the real file's path in the environment, which is the one
 * worth re-running.
 *
 * Returning the plan instead of acting on it lets main.js shut the guests down
 * first, and lets the window be told when a restart is impossible rather than
 * watching nothing happen. */
function prepareRestart() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable) {
    if (!fs.existsSync(portable)) {
      return { ok: false, error: `Cannot restart automatically: ${portable} is no longer there. Close Game Power and open it again to run the new code.` };
    }
    // A portable build takes no arguments of its own.
    return { ok: true, relaunch: { execPath: portable, args: [] } };
  }
  // Dev runs look like "electron.exe . --flags", so the app path has to be
  // carried over or the relaunch starts Electron with nothing to run.
  return { ok: true, relaunch: { args: process.argv.slice(1) } };
}

function restart() {
  const r = prepareRestart();
  if (!r.ok) return r;
  app.relaunch(r.relaunch);
  app.exit(0);
  return { ok: true };
}

module.exports = { check, status, restart, prepareRestart, gitWorkingTree, loadCfg, saveCfg, DEFAULT_CFG };
