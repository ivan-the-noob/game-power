/* ===========================================================================
 * Game Power — the Android layer.
 *
 * Everything that knows what an emulator is lives here: finding the SDK,
 * fetching the packages we need, writing an AVD by hand, booting it headless,
 * and talking to it over ADB.
 *
 * Design notes that matter:
 *
 *  - AVDs live in OUR data folder (userData/avd), not in ~/.android/avd. The
 *    emulator honours ANDROID_AVD_HOME, so cloning and deleting an instance
 *    stays self-contained and never touches the user's own SDK setup.
 *
 *  - Instances run with -no-window. A headless emulator allocates no host
 *    display surface at all, which is the floor for GPU cost; the dashboard
 *    shows it by pulling PNG frames over ADB instead. That is also why tiles
 *    are frames rather than embedded windows: embedding a foreign top-level
 *    window into Electron needs a native addon, frames do not.
 *
 *  - The console port is derived from the instance id, so instance #3 is
 *    always emulator-5558. No port discovery, no races.
 * ======================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ABI = 'x86_64';

/* Which Android version an instance runs.
 *
 * Was hardcoded to android-30 (Android 11) because that is what got downloaded
 * first, not because anything chose it. Newest first: the game's APK needs
 * only minSdk 22 and targets 34, so nothing here is out of its reach, and a
 * newer Android renders through a newer, faster graphics stack.
 *
 * Changing this rebuilds an instance from scratch — a different system image
 * means a different disk, so the app has to be installed again. */
const API_LEVELS = ['android-36', 'android-35', 'android-34', 'android-33', 'android-32', 'android-31', 'android-30'];
let API = API_LEVELS[0];

function setApi(api) {
  if (API_LEVELS.includes(api)) API = api;
  return API;
}
const getApi = () => API;
// Android 16 is API 36, 15 is 35, and so on: the number is the API level.
const apiLabel = (api) => {
  const n = Number(String(api || API).replace(/^android-/, ''));
  const names = { 36: 'Android 16', 35: 'Android 15', 34: 'Android 14', 33: 'Android 13', 32: 'Android 12L', 31: 'Android 12', 30: 'Android 11' };
  return `${names[n] || 'Android'} (API ${n})`;
};

// Which API levels are actually downloaded for the current tag, so the UI can
// only offer images that exist.
function installedApis(tag) {
  const root = sdkRoot();
  const t = tag || TAG;
  return API_LEVELS.filter((a) => fs.existsSync(path.join(root, 'system-images', a, t, ABI, 'system.img')));
}

/* Which system image an instance runs, and why it is the biggest lever there
 * is on memory.
 *
 *   google_apis  Android plus the Google stack. Measured: the emulator refused
 *                a 1024 MB guest and forced 2048 — config.ini asked for 1024,
 *                hardware-qemu.ini recorded 2048, and the guest reported
 *                MemTotal 1.93 GB. On top of that the Play services are
 *                running the whole time.
 *
 *   default      the same Android, built from AOSP, with none of that. No
 *                Play services to run and a lower floor to argue with.
 *
 * The game here is a WebView wrapper with no native code and no Play
 * dependency, so it has nothing to lose by running on AOSP. */
const TAGS = ['default', 'google_apis'];
let TAG = 'default';

function setTag(tag) {
  if (TAGS.includes(tag)) TAG = tag;
  return TAG;
}
const getTag = () => TAG;
const imagePkg = (tag) => `system-images;${API};${tag || TAG};${ABI}`;

// Which image tags are actually downloaded, so the UI can offer a real choice
// rather than one that fails on start.
function installedTags() {
  const root = sdkRoot();
  return TAGS.filter((t) => fs.existsSync(path.join(root, 'system-images', API, t, ABI, 'system.img')));
}

// Console ports must be even and inside this range; two per emulator (console
// + adb), so instances step by 2.
const PORT_BASE = 5554;
const PORT_MAX = 5682;

const portFor = (id) => PORT_BASE + (Number(id) - 1) * 2;
const serialFor = (id) => `emulator-${portFor(id)}`;
const maxInstances = Math.floor((PORT_MAX - PORT_BASE) / 2) + 1;

/* ---- where things are ---------------------------------------------------- */
const exe = (p) => (process.platform === 'win32' ? `${p}.exe` : p);
const bat = (p) => (process.platform === 'win32' ? `${p}.bat` : p);

function sdkRoot() {
  const tries = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : null,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : null,
    path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  for (const p of tries) { if (p && fs.existsSync(p)) return p; }
  // Nothing installed yet: this is where we would put it.
  return tries[tries.length - 1];
}

function paths() {
  const root = sdkRoot();
  return {
    root,
    adb: path.join(root, 'platform-tools', exe('adb')),
    emulator: path.join(root, 'emulator', exe('emulator')),
    sdkmanager: path.join(root, 'cmdline-tools', 'latest', 'bin', bat('sdkmanager')),
    image: path.join(root, 'system-images', API, TAG, ABI),
  };
}

// Set by instances.js once Electron can tell us its userData folder, so this
// module stays usable from a plain node script (the test harnesses do that).
let avdHomeOverride = null;
function setAvdHome(dir) { avdHomeOverride = dir || null; }
function avdHome() {
  if (avdHomeOverride) return avdHomeOverride;
  return path.join(os.homedir(), '.android', 'avd');
}

const avdName = (id) => `gp-${Number(id)}`;
const avdDir = (id) => path.join(avdHome(), `${avdName(id)}.avd`);
const avdIni = (id) => path.join(avdHome(), `${avdName(id)}.ini`);

/* ---- is the machine ready? ----------------------------------------------- */
function health() {
  const p = paths();
  const have = {
    sdk: fs.existsSync(p.root),
    adb: fs.existsSync(p.adb),
    emulator: fs.existsSync(p.emulator),
    sdkmanager: fs.existsSync(p.sdkmanager),
    // The folder alone is not proof: a failed download leaves an empty one
    // behind, which is exactly how a half-finished install looks.
    image: fs.existsSync(path.join(p.image, 'system.img')),
  };
  const missing = [];
  if (!have.emulator) missing.push('emulator');
  if (!have.image) missing.push(imagePkg());
  return {
    ok: have.adb && have.emulator && have.image,
    have,
    missing,
    canInstall: have.sdkmanager,
    paths: p,
    imagePkg: imagePkg(),
    tag: TAG,
    installedTags: installedTags(),
    api: API,
    apiName: apiLabel(API),
    apiLevels: API_LEVELS,
    installedApis: installedApis(),
  };
}

/* ---- setting the SDK up on a machine that has nothing -------------------
 * sdkmanager is the official way, and it is useless on a fresh PC: it ships
 * inside the SDK it is supposed to install, and it needs a JDK. On a machine
 * with neither, "Download and set up" could only ever print an error telling
 * the user to go and install Android Studio first.
 *
 * Everything the emulator needs is published as a plain zip, so fetch those
 * directly instead. No Java, no Android Studio, nothing to install by hand.
 * Windows can unpack a zip on its own, so there is no dependency here at all.
 * ------------------------------------------------------------------------ */
const DL_BASE = 'https://dl.google.com/android/repository/';
const REPO_XML = `${DL_BASE}repository2-3.xml`;
// The AOSP images live in their own index, separate from the Google ones.
const SYSIMG_XML = `${DL_BASE}sys-img/android/sys-img2-3.xml`;
const SYSIMG_XML_GOOGLE = `${DL_BASE}sys-img/google_apis/sys-img2-3.xml`;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    require('https').get(url, { headers: { 'User-Agent': 'GamePower' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url} answered ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u) => {
      require('https').get(u, { headers: { 'User-Agent': 'GamePower' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); go(res.headers.location); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`download failed (${res.statusCode})`)); return; }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        let lastPct = -1;
        res.on('data', (c) => {
          got += c.length;
          if (!total || !onProgress) return;
          const pct = Math.floor((got / total) * 100);
          // Only on change, or this floods the log with one line per packet.
          if (pct !== lastPct && pct % 2 === 0) { lastPct = pct; onProgress(pct, got, total); }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ bytes: got })));
      }).on('error', reject);
    };
    file.on('error', reject);
    go(url);
  });
}

// Windows unpacks zips itself; PowerShell is the way to ask it to.
function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { windowsHide: true, timeout: 900000, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) { reject(new Error(`unzip failed: ${String(stderr || err.message).slice(0, 300)}`)); return; }
      resolve(true);
    });
  });
}

/* Which zip to fetch for each piece.
 *
 * The index lists many builds; the highest build number is the current one,
 * which is what sdkmanager would have picked too. */
async function resolveDownloads(tag) {
  const pick = (xml, re) => {
    const all = [...new Set((xml.match(re) || []))];
    if (!all.length) return null;
    // Sort by the build/revision number inside the name, highest last.
    all.sort((a, b) => (Number((a.match(/(\d+)/g) || []).pop()) - Number((b.match(/(\d+)/g) || []).pop())));
    return all[all.length - 1];
  };

  const repo = await fetchText(REPO_XML);
  const emu = pick(repo, /emulator-windows_x64-\d+\.zip/g);
  if (!emu) throw new Error('Could not find the emulator package in Google\'s index.');

  const imgXml = await fetchText(tag === 'google_apis' ? SYSIMG_XML_GOOGLE : SYSIMG_XML);
  const apiNum = API.replace(/^android-/, '');
  const img = pick(imgXml, new RegExp(`x86_64-${apiNum}_r\\d+\\.zip`, 'g'));
  if (!img) throw new Error(`Could not find a ${tag} system image for ${API} in Google's index.`);

  return {
    // The name doubles as the temp filename, and Expand-Archive refuses
    // anything not actually called .zip — so it must keep the extension.
    platformTools: { url: `${DL_BASE}platform-tools-latest-windows.zip`, name: 'platform-tools-latest-windows.zip' },
    emulator: { url: DL_BASE + emu, name: emu },
    sysImg: { url: `${DL_BASE}sys-img/${tag === 'google_apis' ? 'google_apis' : 'android'}/${img}`, name: img },
  };
}

/* Download and lay out only the pieces that are missing. */
async function bootstrap(onLog) {
  const say = (s) => { try { onLog && onLog(String(s)); } catch (e) { /* ignore */ } };
  const root = sdkRoot();
  const p = paths();
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(os.tmpdir(), 'gp-sdk-dl');
  fs.mkdirSync(tmp, { recursive: true });

  say(`Setting up the Android SDK in ${root}`);
  const want = await resolveDownloads(TAG);

  const jobs = [];
  if (!fs.existsSync(p.adb)) jobs.push({ ...want.platformTools, into: root, label: 'platform-tools (adb)' });
  if (!fs.existsSync(p.emulator)) jobs.push({ ...want.emulator, into: root, label: 'emulator' });
  if (!fs.existsSync(path.join(p.image, 'system.img'))) {
    // The zip holds an "x86_64" folder that belongs under the API and tag.
    jobs.push({ ...want.sysImg, into: path.join(root, 'system-images', API, TAG, '..'), label: `system image (${TAG})`, imageTag: true });
  }
  if (!jobs.length) { say('Already set up.'); return { ok: true, already: true }; }

  for (const job of jobs) {
    const zip = path.join(tmp, job.name);
    say(`Downloading ${job.label}…`);
    try {
      await download(job.url, zip, (pct) => say(`${job.label}: ${pct}%`));
    } catch (e) {
      return { ok: false, error: `Could not download ${job.label}: ${e.message}` };
    }
    say(`Unpacking ${job.label}…`);
    try {
      const into = job.imageTag ? path.join(root, 'system-images', API, TAG) : job.into;
      fs.mkdirSync(into, { recursive: true });
      // The system-image zip already contains an x86_64/ folder, so it is
      // unpacked one level up from where that folder has to end up.
      await unzip(zip, job.imageTag ? path.dirname(into) + path.sep + path.basename(into) : into);
    } catch (e) {
      return { ok: false, error: `Could not unpack ${job.label}: ${e.message}` };
    }
    try { fs.rmSync(zip, { force: true }); } catch (e) { /* ignore */ }
  }

  // The image zip unpacks as <tag>/x86_64/..., flatten if that happened.
  const imgDir = paths().image;
  if (!fs.existsSync(path.join(imgDir, 'system.img'))) {
    const nested = path.join(path.dirname(imgDir), 'x86_64', 'x86_64');
    if (fs.existsSync(path.join(nested, 'system.img'))) {
      say('Tidying the image layout…');
      for (const f of fs.readdirSync(nested)) {
        fs.renameSync(path.join(nested, f), path.join(imgDir, f));
      }
    }
  }

  const after = health();
  if (!after.ok) return { ok: false, error: `Still missing: ${after.missing.join(', ')}`, missing: after.missing };
  say('Android is ready.');
  return { ok: true };
}

/* Is there a JDK, which is the only thing sdkmanager needs that we do not
 * already have? Spelled java.exe on Windows: execFile does not apply PATHEXT
 * to the command itself, so plain 'java' reports ENOENT on a machine that has
 * Java installed and working — which it did here, on a laptop with OpenJDK 17. */
const hasJava = () => {
  const bin = process.platform === 'win32' ? 'java.exe' : 'java';
  try { execFileSync(bin, ['-version'], { windowsHide: true, timeout: 10000, stdio: 'ignore' }); return true; }
  catch (e) { return false; }
};

/* ---- fetching the packages ----------------------------------------------- */
// A long download with licence prompts. Streams its output back so the UI can
// show progress rather than a frozen button.
function installDeps(onLog) {
  const p = paths();
  const h = health();
  const want = h.missing.slice();
  if (!want.length) return Promise.resolve({ ok: true, already: true });
  /* No sdkmanager, or no Java to run it with: fetch the zips directly.
   *
   * This used to give up here and tell the user to install Android Studio
   * first, which made "Download and set up" a button that could only ever
   * print an error on a machine that had nothing — exactly the machine it
   * exists for. */
  if (!h.canInstall || !hasJava()) {
    return bootstrap(onLog);
  }
  return new Promise((resolve) => {
    const say = (s) => { try { onLog && onLog(String(s)); } catch (e) { /* ignore */ } };
    say(`Installing: ${want.join(', ')}`);
    const child = spawn(p.sdkmanager, [`--sdk_root=${p.root}`, ...want], {
      windowsHide: true,
      env: { ...process.env },
    });
    // Accept the licences; sdkmanager asks on stdin.
    const yes = setInterval(() => { try { child.stdin.write('y\n'); } catch (e) { /* ignore */ } }, 400);
    let tail = '';
    const onData = (buf) => {
      const s = buf.toString();
      tail = (tail + s).slice(-4000);
      // Progress arrives as carriage-return redraws; keep only the last line.
      const line = s.split(/[\r\n]+/).filter((x) => x.trim()).pop();
      if (line) say(line.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearInterval(yes); resolve({ ok: false, error: String(e.message || e) }); });
    child.on('close', (code) => {
      clearInterval(yes);
      const after = health();
      if (after.ok) { say('Done.'); resolve({ ok: true }); return; }
      // sdkmanager reports a full disk as a warning and still exits 0, so the
      // health check above is the real verdict and this surfaces the reason.
      const why = /not enough space/i.test(tail)
        ? 'There is not enough free disk space for the Android system image (it needs about 2.5 GB while unpacking).'
        : `sdkmanager exited with ${code}. ${tail.slice(-400)}`;
      resolve({ ok: false, error: why, missing: after.missing });
    });
  });
}

/* ---- the AVD ------------------------------------------------------------
 * Written by hand rather than through avdmanager: avdmanager prompts for a
 * hardware profile on stdin, and we want exact control over the knobs that
 * decide how much RAM and GPU an instance costs. The emulator builds
 * userdata-qemu.img from the system image on first boot, so an AVD folder
 * holding only config.ini is a complete, bootable AVD.
 * ------------------------------------------------------------------------- */
function avdConfig(id, opts) {
  const o = opts || {};
  const ram = Math.max(512, Math.min(4096, parseInt(o.ram, 10) || 1024));
  const cores = Math.max(1, Math.min(4, parseInt(o.cores, 10) || 1));
  const w = Math.max(320, Math.min(1920, parseInt(o.width, 10) || 800));
  const h = Math.max(240, Math.min(1080, parseInt(o.height, 10) || 480));
  const dpi = Math.max(120, Math.min(480, parseInt(o.dpi, 10) || 160));
  const gpu = String(o.gpu || 'swiftshader_indirect');
  const disk = Math.max(2048, Math.min(16384, parseInt(o.diskMB, 10) || 4096));
  return [
    `AvdId=${avdName(id)}`,
    'PlayStore.enabled=false',
    `abi.type=${ABI}`,
    `avd.ini.displayname=${avdName(id)}`,
    'avd.ini.encoding=UTF-8',
    // Everything a game does not need is off: each of these is a driver and a
    // thread inside the guest.
    'hw.accelerometer=no',
    'hw.audioInput=no',
    'hw.audioOutput=no',
    'hw.battery=yes',
    'hw.camera.back=none',
    'hw.camera.front=none',
    `hw.cpu.arch=${ABI}`,
    `hw.cpu.ncore=${cores}`,
    'hw.dPad=no',
    'hw.gps=no',
    'hw.gpu.enabled=yes',
    `hw.gpu.mode=${gpu}`,
    'hw.initialOrientation=landscape',
    'hw.keyboard=yes',
    `hw.lcd.density=${dpi}`,
    `hw.lcd.height=${h}`,
    `hw.lcd.width=${w}`,
    'hw.mainKeys=no',
    `hw.ramSize=${ram}`,
    'hw.sdCard=no',
    'hw.sensors.orientation=no',
    'hw.sensors.proximity=no',
    'hw.trackBall=no',
    `image.sysdir.1=system-images/${API}/${TAG}/${ABI}/`,
    'runtime.network.latency=none',
    'runtime.network.speed=full',
    `tag.id=${TAG}`,
    `disk.dataPartition.size=${disk}M`,
    'vm.heapSize=128',
    'skin.dynamic=yes',
    'showDeviceFrame=no',
    '',
  ].join('\n');
}

function writeIni(id) {
  fs.writeFileSync(avdIni(id), [
    'avd.ini.encoding=UTF-8',
    `path=${avdDir(id)}`,
    `path.rel=avd/${avdName(id)}.avd`,
    `target=${API}`,
    '',
  ].join('\n'));
}

function writeAvd(id, opts) {
  const dir = avdDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.ini'), avdConfig(id, opts));
  writeIni(id);
  return dir;
}

function avdExists(id) { return fs.existsSync(path.join(avdDir(id), 'config.ini')); }

// Re-point a cloned AVD at its own folder: the copied config still carries the
// source's id and the copied .ini still carries the source's path.
function retargetAvd(id, opts) {
  const cfgPath = path.join(avdDir(id), 'config.ini');
  let cfg = '';
  try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { cfg = ''; }
  if (!cfg) { writeAvd(id, opts); return; }
  const set = (k, v) => {
    const re = new RegExp(`^${k.replace(/\./g, '\\.')}=.*$`, 'm');
    cfg = re.test(cfg) ? cfg.replace(re, `${k}=${v}`) : `${cfg}${k}=${v}\n`;
  };
  set('AvdId', avdName(id));
  set('avd.ini.displayname', avdName(id));
  fs.writeFileSync(cfgPath, cfg);
  writeIni(id);
}

// Change the resource knobs on an AVD that already exists, keeping its data.
function tuneAvd(id, opts) {
  const cfgPath = path.join(avdDir(id), 'config.ini');
  if (!fs.existsSync(cfgPath)) return false;
  let cfg = fs.readFileSync(cfgPath, 'utf8');
  const o = opts || {};
  const set = (k, v) => {
    if (v == null) return;
    const re = new RegExp(`^${k.replace(/\./g, '\\.')}=.*$`, 'm');
    cfg = re.test(cfg) ? cfg.replace(re, `${k}=${v}`) : `${cfg}${k}=${v}\n`;
  };
  set('hw.ramSize', o.ram);
  set('hw.cpu.ncore', o.cores);
  set('hw.gpu.mode', o.gpu);
  set('hw.lcd.width', o.width);
  set('hw.lcd.height', o.height);
  set('hw.lcd.density', o.dpi);
  fs.writeFileSync(cfgPath, cfg);
  return true;
}

function deleteAvd(id) {
  try { fs.rmSync(avdDir(id), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(avdIni(id), { force: true }); } catch (e) { /* ignore */ }
}

/* ---- running an emulator ------------------------------------------------- */
function emuEnv() {
  const p = paths();
  return {
    ...process.env,
    ANDROID_SDK_ROOT: p.root,
    ANDROID_HOME: p.root,
    ANDROID_AVD_HOME: avdHome(),
  };
}

// The flags here are the whole "lowest RAM/GPU" story, so they are spelled out
// rather than hidden behind a default.
function emuArgs(id, opts) {
  const o = opts || {};
  const args = [
    '-avd', avdName(id),
    '-port', String(portFor(id)),
    '-no-audio',          // no host audio device, no mixer thread
    '-no-boot-anim',      // the animation is pure GPU work for nothing
    // Quickboot off entirely, not just 'do not save'. With save-only the
    // emulator still keeps a 2 GB ram.img around, which a clone then copies
    // for nothing. Boots are cold either way, since nothing is ever saved.
    '-no-snapshot',
    '-no-metrics',
    '-netdelay', 'none',
    '-netspeed', 'full',
    '-gpu', String(o.gpu || 'swiftshader_indirect'),
    '-memory', String(Math.max(512, Math.min(4096, parseInt(o.ram, 10) || 1024))),
    '-cores', String(Math.max(1, Math.min(4, parseInt(o.cores, 10) || 1))),
  ];
  // Headless unless asked otherwise. This is the single biggest GPU saving,
  // and the dashboard does not need a host window to show the screen.
  if (!o.window) args.push('-no-window');
  if (o.wipe) args.push('-wipe-data');
  if (o.writableSystem) args.push('-writable-system');
  return args;
}

function startEmu(id, opts) {
  const p = paths();
  if (!fs.existsSync(p.emulator)) return { ok: false, error: 'The Android emulator is not installed yet.' };
  if (!avdExists(id)) return { ok: false, error: `Instance #${id} has no AVD yet.` };
  if (portFor(id) > PORT_MAX) return { ok: false, error: `Instance ids above ${maxInstances} have no console port left.` };
  const child = spawn(p.emulator, emuArgs(id, opts), {
    cwd: path.dirname(p.emulator),
    env: emuEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { tail: '' };
  const keep = (b) => { log.tail = (log.tail + b.toString()).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return { ok: true, child, log, serial: serialFor(id), port: portFor(id) };
}

/* Can this machine run a virtual machine at all?
 *
 * The emulator needs hardware acceleration — WHPX on Windows — and without it
 * it exits almost immediately. From the outside that looked identical to a
 * slow boot: the row said "Booting…" with 0 MB and 0% forever, and nothing
 * anywhere said why. The emulator will answer this question directly, so ask
 * it rather than leaving the user staring at a stalled row.
 *
 * The usual cause is virtualization switched off in the BIOS, or Hyper-V
 * missing, neither of which the app can fix — but both of which it can name. */
function accelCheck() {
  const p = paths();
  return new Promise((resolve) => {
    if (!fs.existsSync(p.emulator)) { resolve({ ok: false, reason: 'The emulator is not installed yet.' }); return; }
    execFile(p.emulator, ['-accel-check'], {
      cwd: path.dirname(p.emulator), env: emuEnv(), windowsHide: true, timeout: 30000,
    }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      // It prints "accel: 0 ... is installed and usable" when all is well.
      const good = /accel:\s*0/i.test(out) || /is installed and usable/i.test(out);
      resolve({
        ok: good,
        reason: good ? '' : (out.split(/\r?\n/).filter(Boolean).pop() || 'Hardware acceleration is unavailable.'),
        raw: out.slice(0, 500),
      });
    });
  });
}

/* ---- ADB ----------------------------------------------------------------- */
function adb(args, opts) {
  const p = paths();
  const o = opts || {};
  return new Promise((resolve) => {
    execFile(p.adb, args, {
      env: emuEnv(),
      windowsHide: true,
      timeout: o.timeout || 15000,
      maxBuffer: o.maxBuffer || 8 * 1024 * 1024,
      encoding: o.encoding || 'utf8',
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: stdout == null ? '' : stdout,
        err: String(stderr || (err && err.message) || ''),
      });
    });
  });
}

const sh = (id, cmd, opts) => adb(['-s', serialFor(id), 'shell', cmd], opts);

async function bootState(id) {
  const r = await sh(id, 'getprop sys.boot_completed', { timeout: 4000 });
  if (!r.ok) return 'offline';
  return r.out.trim() === '1' ? 'booted' : 'booting';
}

async function waitBoot(id, ms) {
  const deadline = Date.now() + (ms || 180000);
  while (Date.now() < deadline) {
    if ((await bootState(id)) === 'booted') return { ok: true };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, error: 'Timed out waiting for Android to finish booting.' };
}

/* Screen size in the coordinate space `input tap` actually uses.
 *
 * Measured, not inferred. `wm size` reports the panel in its NATURAL
 * orientation — on a landscape AVD it says 480x800 while the real screen is
 * 800x480 — and correcting that from the reported rotation turned out to be
 * unreliable, which silently sent every tap to the wrong place.
 *
 * The framebuffer cannot be wrong about its own shape: screencap returns a PNG
 * whose IHDR carries the exact dimensions, and that is the same space taps are
 * in. So take a frame and read the header. `wm size` is only the fallback for
 * when screencap fails outright. */
function pngSize(buf) {
  // 8-byte signature, then a 4-byte length + "IHDR", then width and height.
  if (!buf || buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!w || !h || w > 10000 || h > 10000) return null;
  return { w, h };
}

async function screenSize(id) {
  const png = await frame(id).catch(() => null);
  const fromFrame = pngSize(png);
  if (fromFrame) return fromFrame;

  const r = await sh(id, 'wm size', { timeout: 5000 });
  const m = /Override size:\s*(\d+)x(\d+)/.exec(r.out) || /Physical size:\s*(\d+)x(\d+)/.exec(r.out);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

// One PNG frame. exec-out keeps the stream binary, which `shell` would corrupt
// by translating newlines.
function frame(id) {
  const p = paths();
  return new Promise((resolve) => {
    execFile(p.adb, ['-s', serialFor(id), 'exec-out', 'screencap', '-p'], {
      env: emuEnv(),
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    }, (err, stdout) => {
      if (err || !stdout || !stdout.length) { resolve(null); return; }
      resolve(stdout);
    });
  });
}

/* ---- input --------------------------------------------------------------
 * These are real kernel input events as far as Android is concerned, not
 * synthetic ones an app can tell apart — which is the thing the browser
 * recorder could never do for text fields.
 * ------------------------------------------------------------------------- */
const tap = (id, x, y) => sh(id, `input tap ${Math.round(x)} ${Math.round(y)}`, { timeout: 8000 });
const swipe = (id, x1, y1, x2, y2, ms) => sh(id, `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.max(1, Math.round(ms || 200))}`, { timeout: 10000 });
const key = (id, code) => sh(id, `input keyevent ${String(code).replace(/[^A-Z0-9_]/gi, '')}`, { timeout: 8000 });
// `input text` has no escaping of its own: spaces become %s, and the rest is
// kept to a safe set rather than risking the shell.
const typeText = (id, text) => sh(id, `input text '${String(text).replace(/'/g, '').replace(/ /g, '%s')}'`, { timeout: 10000 });

async function installApk(id, apkPath) {
  if (!fs.existsSync(apkPath)) return { ok: false, error: 'That APK file does not exist.' };
  const r = await adb(['-s', serialFor(id), 'install', '-r', '-g', apkPath], { timeout: 600000 });
  const blob = `${r.out}\n${r.err}`;
  if (/Success/i.test(blob)) return { ok: true };
  return { ok: false, error: (blob.match(/Failure[^\n]*/) || [blob.trim().slice(-300)])[0] };
}

async function listApps(id) {
  // Third-party packages only: that is what the user installed, and the only
  // thing worth offering as a launch target.
  const r = await sh(id, 'pm list packages -3', { timeout: 10000 });
  return r.out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();
}

const cleanPkg = (pkg) => String(pkg || '').replace(/[^a-zA-Z0-9_.]/g, '');
const launchApp = (id, pkg) => sh(id, `monkey -p ${cleanPkg(pkg)} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 });
const openUrl = (id, url) => adb(['-s', serialFor(id), 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', String(url)], { timeout: 15000 });
const killEmu = (id) => adb(['-s', serialFor(id), 'emu', 'kill'], { timeout: 8000 });

/* Push the guest's filesystem to its disk image.
 *
 * `adb emu kill` stops the virtual machine; it does not ask Android to shut
 * down, so whatever is still in the guest's page cache is thrown away with
 * it. Measured: a file written and read back correctly was simply gone after
 * a restart — and with it would go the login, the downloaded game, and
 * everything a clone exists to inherit.
 *
 * Generous timeout: this is flushing gigabytes, and it is the one step that
 * must not be cut short. */
const flush = (id) => sh(id, 'sync', { timeout: 60000 });

/* ---- one app and nothing else -------------------------------------------
 * An instance exists to run a single game, so everything the guest would
 * normally do for a person using a phone is dead weight. These are the two
 * halves of that: strip what runs, then keep the app in front.
 * ------------------------------------------------------------------------- */

// Packages worth shutting off. Only things a game never calls into — the
// Google Play *services* an app may genuinely need are deliberately NOT here,
// because disabling those breaks logins and turns a saving into a crash.
const TRIM_PACKAGES = [
  'com.google.android.googlequicksearchbox',  // the search/assistant stack, the single biggest idle user
  'com.google.android.apps.wellbeing',
  'com.google.android.marvin.talkback',
  'com.android.traceur',
  'com.android.printspooler',
  'com.android.bookmarkprovider',
  'com.android.calendar',
  'com.android.deskclock',
  'com.android.email',
  'com.android.gallery3d',
  'com.android.music',
  'com.android.providers.calendar',
  'com.android.wallpaper.livepicker',
  'com.android.dreams.basic',
  'com.android.dreams.phototable',
];

async function trim(id) {
  const done = [];
  // Animations are pure GPU work between screens. Off is both faster and,
  // when the renderer is software, a real CPU saving.
  for (const k of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
    await sh(id, `settings put global ${k} 0`, { timeout: 6000 });
  }
  // The setup wizard otherwise sits in front of the game on a fresh guest.
  await sh(id, 'settings put global device_provisioned 1', { timeout: 6000 });
  await sh(id, 'settings put secure user_setup_complete 1', { timeout: 6000 });
  // Never let the screen sleep: a blank screen means blank frames in the grid.
  await sh(id, 'settings put system screen_off_timeout 2147483647', { timeout: 6000 });
  await sh(id, 'svc power stayon true', { timeout: 6000 });
  for (const pkg of TRIM_PACKAGES) {
    const r = await sh(id, `pm disable-user --user 0 ${pkg}`, { timeout: 8000 });
    if (/new state/i.test(r.out)) done.push(pkg);
  }
  return { ok: true, disabled: done };
}

// Which app is actually in front right now.
async function foregroundPkg(id) {
  const r = await sh(id, 'dumpsys activity activities | grep -m1 mResumedActivity', { timeout: 8000 });
  const m = /\s([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(r.out || '');
  return m ? m[1] : '';
}

// Is the package installed at all? Clones inherit it, so this is also how an
// instance proves it really did get the original's app.
async function hasPkg(id, pkg) {
  const p = cleanPkg(pkg);
  if (!p) return false;
  const r = await sh(id, `pm path ${p}`, { timeout: 8000 });
  return /package:/.test(r.out || '');
}

module.exports = {
  ABI, TAGS, API_LEVELS, maxInstances, setTag, getTag, imagePkg, installedTags,
  setApi, getApi, apiLabel, installedApis,
  paths, sdkRoot, health, installDeps,
  setAvdHome, avdHome, avdName, avdDir, avdIni, avdExists,
  writeAvd, retargetAvd, tuneAvd, deleteAvd, avdConfig,
  portFor, serialFor, startEmu, killEmu, emuArgs,
  adb, sh, bootState, waitBoot, screenSize, frame, pngSize, accelCheck,
  tap, swipe, key, typeText, installApk, listApps, launchApp, openUrl,
  trim, foregroundPkg, hasPkg, cleanPkg, TRIM_PACKAGES, flush,
  bootstrap, resolveDownloads, hasJava,
};
