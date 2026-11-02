/* ===========================================================================
 * Game Power — talking to a game window.
 *
 * Finding a client's window, measuring it, naming it, and sending clicks and
 * keys into it. All of it through PowerShell with a few P/Invoke calls, so
 * there is no native module to build and nothing to go stale when Electron
 * changes version.
 *
 * Two ways to send a click, and the difference matters:
 *
 *   post   PostMessage straight to the window. It does NOT need the window to
 *          be in front, so instances can be driven while you work on
 *          something else — but a game that reads DirectInput or raw input
 *          rather than the window message queue will ignore it.
 *
 *   real   bring the window to the front and use SendInput, which is a real
 *          mouse event the system delivers. Nothing can tell it from a hand on
 *          the mouse, but only one window can be in front at a time, so this
 *          steals focus for each click.
 *
 * Which one a given game needs cannot be known without trying it, so both are
 * here and the caller picks.
 * ======================================================================== */
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

/* One script on disk rather than a fresh -Command string per call: it is long,
 * and quoting it through a shell every time is how subtle breakage happens. */
const PS = `
param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$Pid = 0,
  [long]$Hwnd = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Text = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -Namespace GP -Name W -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr h, string s);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
[DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
[DllImport("user32.dll")] public static extern short VkKeyScanW(char c);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
'@

function Get-MainWindow([int]$targetPid) {
  $found = @()
  $cb = [GP.W+EnumWindowsProc]{
    param($h, $l)
    $wpid = 0
    [void][GP.W]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($wpid -eq $targetPid -and [GP.W]::IsWindowVisible($h) -and [GP.W]::GetParent($h) -eq [IntPtr]::Zero) {
      $r = New-Object GP.W+RECT
      [void][GP.W]::GetClientRect($h, [ref]$r)
      # Skip tool windows and tiny helpers: the game window is the big one.
      if (($r.Right - $r.Left) -ge 200 -and ($r.Bottom - $r.Top) -ge 150) {
        $script:found += ,@{ h = $h; w = ($r.Right - $r.Left); ht = ($r.Bottom - $r.Top) }
      }
    }
    return $true
  }
  $script:found = @()
  [void][GP.W]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:found.Count -eq 0) { return $null }
  # The largest client area is the game, not a splash or a dialog.
  return ($script:found | Sort-Object { $_.w * $_.ht } -Descending)[0]
}

switch ($Action) {
  'find' {
    $w = Get-MainWindow $Pid
    if (-not $w) { 'NONE'; break }
    $sb = New-Object System.Text.StringBuilder 512
    [void][GP.W]::GetWindowTextW($w.h, $sb, 512)
    $wr = New-Object GP.W+RECT
    [void][GP.W]::GetWindowRect($w.h, [ref]$wr)
    'OK|' + [int64]$w.h + '|' + $w.w + '|' + $w.ht + '|' + $wr.Left + '|' + $wr.Top + '|' + $sb.ToString()
  }
  'title' {
    [void][GP.W]::SetWindowTextW([IntPtr]$Hwnd, $Text)
    'OK'
  }
  'move' {
    # 0x0014 = NOZORDER | NOACTIVATE: place it without pulling it to the front.
    [void][GP.W]::SetWindowPos([IntPtr]$Hwnd, [IntPtr]::Zero, $X, $Y, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)
    'OK'
  }
  'focus' {
    [void][GP.W]::ShowWindow([IntPtr]$Hwnd, 5)
    [void][GP.W]::SetForegroundWindow([IntPtr]$Hwnd)
    'OK'
  }
  'post' {
    # Client coordinates packed into lParam, the way Windows sends them.
    $lp = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
    [void][GP.W]::PostMessageW([IntPtr]$Hwnd, 0x0200, [IntPtr]0, $lp)        # WM_MOUSEMOVE
    [void][GP.W]::PostMessageW([IntPtr]$Hwnd, 0x0201, [IntPtr]1, $lp)        # WM_LBUTTONDOWN
    Start-Sleep -Milliseconds 40
    [void][GP.W]::PostMessageW([IntPtr]$Hwnd, 0x0202, [IntPtr]0, $lp)        # WM_LBUTTONUP
    'OK'
  }
  'real' {
    $p = New-Object GP.W+POINT
    $p.X = $X; $p.Y = $Y
    [void][GP.W]::ClientToScreen([IntPtr]$Hwnd, [ref]$p)
    [void][GP.W]::ShowWindow([IntPtr]$Hwnd, 5)
    [void][GP.W]::SetForegroundWindow([IntPtr]$Hwnd)
    Start-Sleep -Milliseconds 60
    [void][GP.W]::SetCursorPos($p.X, $p.Y)
    Start-Sleep -Milliseconds 20
    [GP.W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
    Start-Sleep -Milliseconds 40
    [GP.W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
    'OK'
  }
  'type' {
    foreach ($ch in $Text.ToCharArray()) {
      [void][GP.W]::PostMessageW([IntPtr]$Hwnd, 0x0102, [IntPtr][int][char]$ch, [IntPtr]1)   # WM_CHAR
      Start-Sleep -Milliseconds 15
    }
    'OK'
  }
  'key' {
    # Only the handful a game login needs, by virtual-key code.
    $map = @{ 'ENTER' = 0x0D; 'TAB' = 0x09; 'BACK' = 0x08; 'ESC' = 0x1B }
    if (-not $map.ContainsKey($Text)) { 'ERR unknown key'; break }
    $vk = [byte]$map[$Text]
    [void][GP.W]::PostMessageW([IntPtr]$Hwnd, 0x0100, [IntPtr][int]$vk, [IntPtr]1)   # WM_KEYDOWN
    Start-Sleep -Milliseconds 25
    [void][GP.W]::PostMessageW([IntPtr]$Hwnd, 0x0101, [IntPtr][int]$vk, [IntPtr]1)   # WM_KEYUP
    'OK'
  }
  default { 'ERR unknown action' }
}
`;

let scriptPath = null;
function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const p = path.join(os.tmpdir(), 'gp-winapi.ps1');
  try { fs.writeFileSync(p, PS, 'utf8'); scriptPath = p; } catch (e) { scriptPath = null; }
  return scriptPath;
}

function run(args, timeout) {
  const script = ensureScript();
  return new Promise((resolve) => {
    if (!script || process.platform !== 'win32') { resolve({ ok: false, out: '', err: 'not windows' }); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
      timeout: timeout || 15000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      resolve({ ok: !err && !out.startsWith('ERR'), out, err: String(stderr || (err && err.message) || '') });
    });
  });
}

/* The game's main window, by process id. Returns null while it is still
 * starting — a client that has not drawn yet has no window to find. */
async function findWindow(pid) {
  const r = await run(['-Action', 'find', '-Pid', String(Number(pid) || 0)], 10000);
  if (!r.ok || !r.out.startsWith('OK|')) return null;
  const [, hwnd, w, h, x, y, ...rest] = r.out.split('|');
  return {
    hwnd: Number(hwnd),
    w: Number(w),
    h: Number(h),
    x: Number(x),
    y: Number(y),
    title: rest.join('|'),
  };
}

const setTitle = (hwnd, text) => run(['-Action', 'title', '-Hwnd', String(hwnd), '-Text', String(text).slice(0, 200)]);
const moveWindow = (hwnd, x, y) => run(['-Action', 'move', '-Hwnd', String(hwnd), '-X', String(Math.round(x)), '-Y', String(Math.round(y))]);
const focusWindow = (hwnd) => run(['-Action', 'focus', '-Hwnd', String(hwnd)]);

/* A click at client coordinates. `real` decides whether it is a posted
 * message (no focus stolen, but ignorable by the game) or an actual system
 * mouse event (undeniable, but it takes the foreground). */
const click = (hwnd, x, y, real) => run([
  '-Action', real ? 'real' : 'post',
  '-Hwnd', String(hwnd),
  '-X', String(Math.round(x)),
  '-Y', String(Math.round(y)),
], 20000);

const typeText = (hwnd, text) => run(['-Action', 'type', '-Hwnd', String(hwnd), '-Text', String(text).slice(0, 500)], 30000);
const key = (hwnd, name) => run(['-Action', 'key', '-Hwnd', String(hwnd), '-Text', String(name).toUpperCase()]);

module.exports = { findWindow, setTitle, moveWindow, focusWindow, click, typeText, key, run };
