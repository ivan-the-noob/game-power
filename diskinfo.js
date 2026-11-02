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
const { execFile } = require('child_process');

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

module.exports = { allocatedDirs, dirLength, freeBytes };
