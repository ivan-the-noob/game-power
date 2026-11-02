/* ===========================================================================
 * Game Power — the Windows game client layer.
 *
 * This replaces the Android emulator, and the reason is simple: the game has
 * no Android build at all. What it has is a native Windows client, which is
 * both lighter than an emulator and lighter than a browser.
 *
 * The model survives unchanged — one original, every other instance a copy of
 * it — but a "copy" is now almost free, because of how the install is shaped:
 *
 *     POGI.XEY    8.96 GB    packed game data, read only
 *     arcade/     1.11 GB    assets, read only
 *     Sound/      394 MB     assets, read only
 *     3ddata/     12 MB      assets, read only
 *     everything else        14 MB
 *
 * So an instance folder is built out of LINKS to the big read-only data and
 * real copies of only the small writable files. Measured: a hard link to the
 * 8.96 GB data file takes 4 ms and 0 bytes. An instance costs ~14 MB of disk
 * instead of 10.5 GB, and is ready in about a second.
 *
 * What must NOT be linked is anything the game writes: its settings file and
 * the folders it drops logs, screenshots and downloaded images into. A write
 * through a link would reach the shared original and every other instance.
 * ======================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// The launcher knows these names and starts whichever it finds; so do we.
const CLIENT_EXES = ['TRose.exe', 'trose.exe', 'rose.exe', 'roseonline.exe', 'rose online.exe'];

/* Read-only asset folders: one junction each instead of a hard link per file.
 * Sound/ alone is 1016 files — three junctions is three operations. */
const LINK_DIRS = ['3ddata', 'arcade', 'Sound'];

/* Folders the game writes into. Each instance needs its own, or instances
 * would overwrite each other's logs, screenshots and clan images. */
const OWN_DIRS = ['Config', 'Chat', 'capture', 'clanmark'];

/* Files the game writes. Copied per instance, never linked: this is where the
 * resolution, volume and per-account settings live, and it is the file that
 * makes one instance different from another. */
const OWN_FILE_RE = /\.(ini|cfg|log|dat|idx|sav)$/i;

/* Anything this big is data, not configuration — link it. */
const LINK_IF_BIGGER = 32 * 1024 * 1024;

const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

/* ---- finding the install ------------------------------------------------- */
function findExe(dir) {
  if (!dir || !exists(dir)) return null;
  for (const name of CLIENT_EXES) {
    const p = path.join(dir, name);
    if (exists(p)) return name;
  }
  // Fall back to any .exe that is not the launcher.
  try {
    const hit = fs.readdirSync(dir).find((f) => /\.exe$/i.test(f) && !/launcher/i.test(f));
    if (hit) return hit;
  } catch (e) { /* ignore */ }
  return null;
}

/* Does this folder look like a game install we can build instances from? */
function inspect(dir) {
  const out = { ok: false, dir: dir || '', exe: null, bigFiles: [], linkDirs: [], totalMB: 0, error: '' };
  if (!dir) { out.error = 'No game folder set yet.'; return out; }
  if (!exists(dir)) { out.error = `${dir} does not exist.`; return out; }
  const exe = findExe(dir);
  if (!exe) { out.error = `No game executable found in ${dir} (looked for ${CLIENT_EXES.slice(0, 3).join(', ')}).`; return out; }
  out.exe = exe;

  let bytes = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile()) {
        const sz = (() => { try { return fs.statSync(p).size; } catch (x) { return 0; } })();
        bytes += sz;
        if (sz >= LINK_IF_BIGGER) out.bigFiles.push({ name: e.name, mb: Math.round(sz / (1024 * 1024)) });
      } else if (e.isDirectory() && LINK_DIRS.includes(e.name)) {
        out.linkDirs.push(e.name);
      }
    }
  } catch (e) { out.error = String(e.message || e); return out; }

  out.totalMB = Math.round(bytes / (1024 * 1024));
  out.ok = true;
  return out;
}

/* ---- building one instance folder ---------------------------------------
 * Three kinds of entry, and which kind something is decides whether the
 * instance shares it or owns it:
 *
 *   junction  a read-only asset folder            free, instant
 *   hard link a big read-only file                free, instant
 *   copy      anything the game might write to    real bytes, but tiny
 *
 * Hard links and junctions are the same data on disk under a second name, so
 * a write through one is a write to the original. That is exactly why the
 * writable set is copied instead.
 * ----------------------------------------------------------------------- */
function buildInstance(srcDir, destDir, onStep) {
  const report = { linked: 0, junctions: 0, copied: 0, copiedBytes: 0, warnings: [] };
  const step = (s) => { try { onStep && onStep(s); } catch (e) { /* ignore */ } };

  if (!exists(srcDir)) throw new Error(`The game folder ${srcDir} is not there.`);
  fs.mkdirSync(destDir, { recursive: true });

  const sameVolume = path.parse(path.resolve(srcDir)).root.toLowerCase()
    === path.parse(path.resolve(destDir)).root.toLowerCase();

  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); }
  catch (e) { throw new Error(`Cannot read ${srcDir}: ${e.message}`); }

  for (const e of entries) {
    const from = path.join(srcDir, e.name);
    const to = path.join(destDir, e.name);

    if (e.isDirectory()) {
      if (OWN_DIRS.includes(e.name)) {
        // The instance's own, empty: this is where it writes.
        fs.mkdirSync(to, { recursive: true });
        continue;
      }
      if (LINK_DIRS.includes(e.name) || isAssetDir(from)) {
        step(`linking ${e.name}/`);
        try {
          if (exists(to)) fs.rmSync(to, { recursive: true, force: true });
          // 'junction' is a Windows directory link; no admin rights needed,
          // unlike a directory symlink.
          fs.symlinkSync(path.resolve(from), to, 'junction');
          report.junctions += 1;
          continue;
        } catch (err) {
          report.warnings.push(`${e.name}/: could not link (${err.code || err.message}), copied instead`);
        }
      }
      // Anything unrecognised is copied, so a folder we have not seen before
      // can never be shared by accident.
      step(`copying ${e.name}/`);
      copyTree(from, to, report);
      continue;
    }

    if (!e.isFile()) continue;

    let size = 0;
    try { size = fs.statSync(from).size; } catch (err) { continue; }
    const writable = OWN_FILE_RE.test(e.name);
    const big = size >= LINK_IF_BIGGER;

    if (!writable && big && sameVolume) {
      step(`linking ${e.name}`);
      try {
        if (exists(to)) fs.rmSync(to, { force: true });
        fs.linkSync(from, to);
        report.linked += 1;
        continue;
      } catch (err) {
        report.warnings.push(`${e.name}: could not hard link (${err.code || err.message}), copied instead`);
      }
    }

    step(`copying ${e.name}`);
    try {
      fs.copyFileSync(from, to);
      report.copied += 1;
      report.copiedBytes += size;
    } catch (err) {
      report.warnings.push(`${e.name}: ${err.code || err.message}`);
    }
  }

  return report;
}

// A folder of nothing but assets can be shared even if it is not on the known
// list — but only when it holds no settings the game would write back.
function isAssetDir(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return false; }
  if (!names.length) return false;
  return !names.some((n) => OWN_FILE_RE.test(n));
}

function copyTree(src, dest, report) {
  fs.mkdirSync(dest, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) { copyTree(from, to, report); continue; }
    if (!e.isFile()) continue;
    try {
      fs.copyFileSync(from, to);
      report.copied += 1;
      report.copiedBytes += fs.statSync(to).size;
    } catch (err) {
      report.warnings.push(`${e.name}: ${err.code || err.message}`);
    }
  }
}

/* Remove an instance folder.
 *
 * Junctions must be unlinked rather than walked into: deleting one
 * recursively would delete the shared assets it points at, taking the
 * original install with it. fs.rmSync does not follow them, but the
 * junctions are removed explicitly first so that is not left to trust. */
function removeInstance(destDir) {
  if (!exists(destDir)) return;
  let entries = [];
  try { entries = fs.readdirSync(destDir, { withFileTypes: true }); } catch (e) { entries = []; }
  for (const e of entries) {
    const p = path.join(destDir, e.name);
    if (e.isSymbolicLink() || (e.isDirectory() && isLink(p))) {
      try { fs.unlinkSync(p); } catch (err) { try { fs.rmdirSync(p); } catch (x) { /* ignore */ } }
    }
  }
  fs.rmSync(destDir, { recursive: true, force: true });
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; }
}

/* ---- per-instance settings ---------------------------------------------
 * Sevenhearts.ini carries the window size, which is what lets the dashboard
 * show a wall of small clients instead of a wall of 1572x986 ones.
 * ----------------------------------------------------------------------- */
function readIni(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1]; out[section] = out[section] || {}; continue; }
    const kv = /^([^=;#]+)=(.*)$/.exec(line);
    if (kv && section) out[section][kv[1].trim()] = kv[2].trim();
  }
  return out;
}

// Rewrites only the keys asked for, keeping every other line and its order:
// the file holds dozens of settings we have no business reordering.
function patchIni(file, changes) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const want = new Map();
  for (const [sec, kvs] of Object.entries(changes)) {
    for (const [k, v] of Object.entries(kvs)) want.set(`${sec.toLowerCase()}|${k.toLowerCase()}`, String(v));
  }
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(lines[i]);
    if (sec) { section = sec[1]; continue; }
    const kv = /^(\s*)([^=;#]+)=(.*)$/.exec(lines[i]);
    if (!kv || !section) continue;
    const key = `${section.toLowerCase()}|${kv[2].trim().toLowerCase()}`;
    if (want.has(key)) {
      lines[i] = `${kv[1]}${kv[2].trim()}=${want.get(key)}`;
      want.delete(key);
    }
  }
  // Anything the file did not already have gets appended under its section.
  if (want.size) {
    for (const [key, v] of want) {
      const [sec, k] = key.split('|');
      lines.push(`[${sec.toUpperCase()}]`, `${k.toUpperCase()}=${v}`);
    }
  }
  try { fs.writeFileSync(file, lines.join(eol)); return true; } catch (e) { return false; }
}

/* ---- running one ------------------------------------------------------- */
function launch(instanceDir, exeName) {
  const exe = path.join(instanceDir, exeName);
  if (!exists(exe)) return { ok: false, error: `${exeName} is not in ${instanceDir}.` };
  // The working directory has to be the instance's own folder: the client
  // reads its settings and writes its logs relative to where it runs, which
  // is the whole mechanism keeping instances apart.
  const child = spawn(exe, [], {
    cwd: instanceDir,
    windowsHide: false,
    detached: false,
    stdio: 'ignore',
  });
  return { ok: true, child, pid: child.pid, exe };
}

module.exports = {
  CLIENT_EXES, LINK_DIRS, OWN_DIRS, LINK_IF_BIGGER,
  findExe, inspect, buildInstance, removeInstance,
  readIni, patchIni, launch,
};
