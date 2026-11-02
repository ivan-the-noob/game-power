/* ===========================================================================
 * Game Power — per-process RAM and CPU for processes we did not spawn inside
 * Electron.
 *
 * app.getAppMetrics() only knows about Electron's own processes. An emulator
 * is a separate program, and worse, the memory is not even in the process we
 * spawned: emulator.exe is a launcher that starts qemu-system-x86_64, and the
 * guest's whole RAM lives in that child. So the honest cost of an instance is
 * its process TREE, not its process.
 *
 * One OS call per poll covers every instance at once — spawning a reader per
 * instance would cost more than the thing it measures.
 * ======================================================================== */
const { execFile } = require('child_process');

// pid -> { cpu100ns, at } from the previous sample, so CPU can be a rate.
const prev = new Map();
let cores = 1;
try { cores = Math.max(1, require('os').cpus().length); } catch (e) { cores = 1; }

/* Why the private working set and not WorkingSetSize.
 *
 * An emulator memory-maps the 3.2 GB Android system image. Those pages are
 * file-backed and shared, but WorkingSetSize counts them, so a single empty
 * instance measured 3018 MB — a number that made trimming the guest look
 * useless and would have told the user they were out of memory when they were
 * not. WorkingSetPrivate is the memory that genuinely belongs to the process,
 * which is what "what is this instance costing me" means.
 *
 * Win32_Process is still the source for parentage and CPU time; the perf class
 * is joined onto it by pid, so this stays one call. */
const PS_SNAPSHOT = `
$ErrorActionPreference='SilentlyContinue'
$priv=@{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,WorkingSetPrivate |
  ForEach-Object { if ($_.IDProcess) { $priv[[int]$_.IDProcess] = [int64]$_.WorkingSetPrivate } }
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime |
  ForEach-Object {
    $pid2 = [int]$_.ProcessId
    $w = if ($priv.ContainsKey($pid2)) { $priv[$pid2] } else { [int64]$_.WorkingSetSize }
    '{0},{1},{2},{3}' -f $pid2, $_.ParentProcessId, $w, ([int64]$_.KernelModeTime + [int64]$_.UserModeTime)
  }
`;

function snapshot() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SNAPSHOT], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      // pid -> { pid, ppid, ws, cpu100ns }
      const byPid = new Map();
      const kids = new Map();
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.split(',');
        if (parts.length !== 4) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        const ws = Number(parts[2]);
        const cpu = Number(parts[3]);
        if (!pid || !Number.isFinite(ws)) continue;
        byPid.set(pid, { pid, ppid, ws, cpu });
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      resolve({ byPid, kids, at: Date.now() });
    });
  });
}

// Every pid at or under `root`, so a launcher and the VM it started count as
// one instance.
function treePids(snap, root) {
  const out = [];
  const seen = new Set();
  const stack = [Number(root)];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    if (snap.byPid.has(pid)) out.push(pid);
    for (const k of (snap.kids.get(pid) || [])) stack.push(k);
  }
  return out;
}

/* Totals for one process tree. CPU is a percentage of ONE core's worth of
 * time spread over the whole machine, matching how Task Manager reports it. */
function tree(snap, root) {
  if (!snap || !root) return { ramMB: 0, cpu: 0, pids: 0 };
  const pids = treePids(snap, root);
  let ws = 0;
  let cpu = 0;
  for (const pid of pids) {
    const p = snap.byPid.get(pid);
    if (!p) continue;
    ws += p.ws;
    cpu += p.cpu;
  }
  const before = prev.get(Number(root));
  let pct = 0;
  if (before && snap.at > before.at) {
    // KernelModeTime + UserModeTime are in 100-nanosecond units.
    const cpuMs = (cpu - before.cpu) / 10000;
    const wallMs = snap.at - before.at;
    if (wallMs > 0) pct = Math.max(0, Math.min(100, (cpuMs / (wallMs * cores)) * 100));
  }
  prev.set(Number(root), { cpu, at: snap.at });
  return {
    ramMB: Math.round(ws / (1024 * 1024)),
    cpu: Math.round(pct * 10) / 10,
    pids: pids.length,
  };
}

function forget(root) { prev.delete(Number(root)); }

/* Find a process by what it was launched with.
 *
 * emulator.exe is a launcher: depending on the build it either keeps the VM as
 * its child or hands off to a qemu process that is NOT its descendant, in
 * which case the pid we spawned tells us nothing. Every emulator carries its
 * AVD name on the command line, so that is the reliable handle.
 *
 * Returns the LOWEST matching pid, which is the launcher when it is still
 * around and the VM itself when it is not. */
function findByCmdline(needle) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    const safe = String(needle).replace(/['%]/g, '');
    const ps = `
$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${safe}%'" -Property ProcessId,CommandLine |
  ForEach-Object { $_.ProcessId }
`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const pids = stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => n > 0);
      resolve(pids.length ? Math.min(...pids) : null);
    });
  });
}

// Kill a process and everything under it. An emulator that loses only its
// launcher leaves the VM running and the guest's RAM with it.
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) { resolve(false); return; }
    if (process.platform !== 'win32') {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { /* already gone */ }
      resolve(true);
      return;
    }
    execFile('taskkill.exe', ['/PID', String(Number(pid)), '/T', '/F'], {
      windowsHide: true, timeout: 10000,
    }, () => resolve(true));
  });
}

module.exports = { snapshot, tree, treePids, forget, findByCmdline, killTree, cores };
