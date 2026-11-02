/* ===========================================================================
 * Game Power — how much disk an instance really uses.
 *
 * An AVD's data partition is a SPARSE file. A fresh instance reports 6 GB of
 * userdata-qemu.img by file length while occupying about 2.6 GB of actual
 * disk, because the untouched middle of the partition was never written.
 *
 * That gap matters twice over:
 *   - shown to the user, the file length is simply a lie about their disk;
 *   - used to decide whether a clone fits, it refuses clones that would fit.
 *
 * So ask Windows for the allocated size rather than the length.
 * GetCompressedFileSize returns the bytes a file actually occupies, sparse
 * holes and NTFS compression included. One call covers every folder.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// PowerShell string literal: single-quoted, with inner quotes doubled.
const psStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

const SCRIPT_HEAD = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -Namespace GP -Name Fs -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern uint GetCompressedFileSize(string name, out uint high);
'@
function Get-Alloc([string]$f) {
  $high = 0
  $low = [GP.Fs]::GetCompressedFileSize($f, [ref]$high)
  if ($low -eq 0xFFFFFFFF -and $high -eq 0) { return 0 }
  return ([int64]$high * 4294967296) + [int64]$low
}
`;

/* Allocated bytes for each directory given, as { dir: bytes }.
 * Falls back to file lengths wherever the OS call is unavailable. */
function allocatedDirs(dirs) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  if (!list.length) return Promise.resolve({});
  if (process.platform !== 'win32') return Promise.resolve(fallback(list));

  const body = list.map((d, i) => `
$t = [int64]0
if (Test-Path ${psStr(d)}) {
  Get-ChildItem -LiteralPath ${psStr(d)} -Recurse -File -Force | ForEach-Object { $t += (Get-Alloc $_.FullName) }
}
Write-Output ('${i}|' + $t)
`).join('\n');

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT_HEAD + body], {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) { resolve(fallback(list)); return; }
      const out = {};
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^(\d+)\|(\d+)$/.exec(line.trim());
        if (!m) continue;
        const dir = list[Number(m[1])];
        if (dir != null) out[dir] = Number(m[2]);
      }
      // Any folder the script could not report gets the length-based answer
      // rather than a zero, which would read as "uses no disk".
      for (const d of list) if (out[d] == null) out[d] = dirLength(d);
      resolve(out);
    });
  });
}

function dirLength(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirLength(p);
    else if (e.isFile()) { try { total += fs.statSync(p).size; } catch (err) { /* ignore */ } }
  }
  return total;
}

function fallback(list) {
  const out = {};
  for (const d of list) out[d] = dirLength(d);
  return out;
}

// Free space on the volume a path lives on.
function freeBytes(p) {
  try {
    const st = fs.statfsSync(p);
    return st.bavail * st.bsize;
  } catch (e) { return 0; }
}

/* ---- copying a sparse file without filling the disk ---------------------
 * fs.copyFileSync expands holes into real zeros. Measured: a 2 GB file with
 * nothing in it (0 MB allocated) copied to 2048 MB allocated. An AVD's data
 * partition is 6 GB of mostly holes holding 2.4 GB, so copying it that way
 * needs two and a half times the disk it should — which is precisely how
 * cloning ran out of space and produced a clone with no data partition.
 *
 * So copy it by hand: mark the destination sparse, then write only the chunks
 * that are not entirely zero. Everything skipped stays a hole.
 *
 * This is also why the destination must be truncated to the source's length
 * at the end: a trailing run of zeros is never written, so without that the
 * file would come out short and qemu would refuse it.
 * ----------------------------------------------------------------------- */
const CHUNK = 4 * 1024 * 1024;
const ZERO = Buffer.alloc(CHUNK);

// Ask NTFS to allow holes in this file. Not fatal if it fails: the copy still
// produces correct bytes, it just takes the space it would have taken anyway.
function setSparseFlag(file) {
  if (process.platform !== 'win32') return true;
  try {
    execFileSync('fsutil.exe', ['sparse', 'setflag', file], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

function copySparseSync(src, dst, onBytes) {
  const size = fs.statSync(src).size;
  // Truncate/create first so the sparse flag has a file to land on.
  fs.closeSync(fs.openSync(dst, 'w'));
  const sparse = setSparseFlag(dst);

  const rfd = fs.openSync(src, 'r');
  const wfd = fs.openSync(dst, 'r+');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const got = fs.readSync(rfd, buf, 0, want, pos);
      if (got <= 0) break;
      // A chunk of pure zeros is left as a hole. `equals` on a subarray is a
      // memcmp, so this costs far less than writing the bytes would.
      const blank = got === CHUNK ? buf.equals(ZERO) : buf.subarray(0, got).equals(ZERO.subarray(0, got));
      if (!blank) fs.writeSync(wfd, buf, 0, got, pos);
      pos += got;
      if (onBytes) onBytes(got);
    }
    // Give the file its real length, holes at the end included.
    fs.ftruncateSync(wfd, size);
  } finally {
    try { fs.closeSync(rfd); } catch (e) { /* ignore */ }
    try { fs.closeSync(wfd); } catch (e) { /* ignore */ }
  }
  return { size, sparse };
}

/* The same copy, but yielding to the event loop as it goes.
 *
 * A 6 GB image takes tens of seconds. Done synchronously in the main process
 * that freezes the whole app — no progress bar, no Stop, nothing — so hand
 * control back every so often. The work itself is still synchronous per
 * chunk, which is what keeps it fast; only the pauses are awaited. */
const YIELD_EVERY = 8;   // chunks, i.e. every 32 MB

async function copySparse(src, dst, onBytes) {
  const size = fs.statSync(src).size;
  fs.closeSync(fs.openSync(dst, 'w'));
  const sparse = setSparseFlag(dst);

  const rfd = fs.openSync(src, 'r');
  const wfd = fs.openSync(dst, 'r+');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let n = 0;
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const got = fs.readSync(rfd, buf, 0, want, pos);
      if (got <= 0) break;
      const blank = got === CHUNK ? buf.equals(ZERO) : buf.subarray(0, got).equals(ZERO.subarray(0, got));
      if (!blank) fs.writeSync(wfd, buf, 0, got, pos);
      pos += got;
      if (onBytes) onBytes(got);
      n += 1;
      if (n % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    }
    fs.ftruncateSync(wfd, size);
  } finally {
    try { fs.closeSync(rfd); } catch (e) { /* ignore */ }
    try { fs.closeSync(wfd); } catch (e) { /* ignore */ }
  }
  return { size, sparse };
}

module.exports = { allocatedDirs, dirLength, freeBytes, copySparse, copySparseSync, setSparseFlag };
