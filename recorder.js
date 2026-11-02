/* ===========================================================================
 * Game Power — the click recorder.
 *
 * Same idea as the browser version, different mechanism, and the difference
 * is the point. There, a recorded click was a synthetic DOM event the page
 * could tell apart from a real one — which is why replaying a click into a
 * username field never focused it. Here a step is an ADB tap, which Android
 * delivers through the same path as a finger. Nothing can tell them apart, so
 * text fields, buttons and canvases all behave.
 *
 * A step is stored in DEVICE pixels, not as a fraction of a tile, so a
 * recording replays identically whatever size you were viewing at.
 *
 * Recordings live in userData/recordings/<id>.json, so they outlive a restart
 * and can be replayed on ANY instance — record once on the original, run it on
 * every clone.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

const android = require('./android');

const MAX_STEPS = 2000;

// id -> runtime state. Nothing in here is persisted; the steps are.
const live = new Map();

let dir = null;
let notify = () => {};

function configure(opts) {
  if (opts && opts.dir) {
    dir = opts.dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  }
  if (opts && typeof opts.onState === 'function') notify = opts.onState;
}

const fileFor = (id) => path.join(dir || '.', `rec-${Number(id)}.json`);

function st(id) {
  const key = Number(id);
  if (!live.has(key)) {
    live.set(key, { recording: false, playing: false, loop: 0, step: 0, total: 0, lastAt: 0, stopFlag: false, msg: '' });
  }
  return live.get(key);
}

/* ---- stored steps -------------------------------------------------------- */
function loadSteps(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
    const steps = Array.isArray(raw && raw.steps) ? raw.steps : [];
    return steps
      .filter((s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y)))
      .map((s) => ({ x: Number(s.x), y: Number(s.y), dt: Math.max(0, Number(s.dt) || 0) }))
      .slice(0, MAX_STEPS);
  } catch (e) { return []; }
}

function saveSteps(id, steps) {
  if (!dir) return;
  try {
    fs.writeFileSync(fileFor(id), JSON.stringify({
      id: Number(id),
      savedAt: Date.now(),
      steps: steps.slice(0, MAX_STEPS),
    }, null, 1));
  } catch (e) { /* ignore */ }
}

/* ---- state the UI shows -------------------------------------------------- */
function state(id) {
  const s = st(id);
  const steps = s.recording ? (s.buf || []) : loadSteps(id);
  return {
    id: Number(id),
    recording: !!s.recording,
    playing: !!s.playing,
    steps: steps.length,
    loop: s.loop,
    step: s.step,
    total: s.total,
    msg: s.msg || '',
  };
}

function push(id) { try { notify(Number(id), state(id)); } catch (e) { /* ignore */ } }

/* ---- recording -----------------------------------------------------------
 * There is nothing to poll: taps arrive because the dashboard sent them, so
 * recording is simply "remember what we were asked to inject". That also
 * means a recording can never contain a tap the instance did not receive.
 * -------------------------------------------------------------------------- */
function record(id) {
  const s = st(id);
  if (s.playing) return { ok: false, error: 'Stop playback first.' };
  s.recording = true;
  s.buf = [];
  s.lastAt = 0;
  s.msg = 'Recording — every tap on this instance is being saved.';
  push(id);
  return { ok: true };
}

function stopRecord(id) {
  const s = st(id);
  if (!s.recording) return { ok: true };
  s.recording = false;
  const steps = s.buf || [];
  saveSteps(id, steps);
  s.buf = null;
  s.msg = `Saved ${steps.length} step${steps.length === 1 ? '' : 's'}.`;
  push(id);
  return { ok: true, steps: steps.length };
}

// Called by instances.tapNorm for every tap that actually went to a guest.
function noteTap(id, x, y) {
  const s = st(id);
  if (!s.recording) return;
  const now = Date.now();
  const dt = s.lastAt ? now - s.lastAt : 0;
  s.lastAt = now;
  if (!s.buf) s.buf = [];
  if (s.buf.length >= MAX_STEPS) return;
  s.buf.push({ x: Math.round(x), y: Math.round(y), dt });
  push(id);
}

function clear(id) {
  const s = st(id);
  if (s.playing) return { ok: false, error: 'Stop playback first.' };
  s.buf = null;
  s.recording = false;
  try { fs.rmSync(fileFor(id), { force: true }); } catch (e) { /* ignore */ }
  s.msg = 'Cleared.';
  push(id);
  return { ok: true };
}

const exportSteps = (id) => ({ ok: true, steps: loadSteps(id) });

function importSteps(id, steps) {
  if (!Array.isArray(steps)) return { ok: false, error: 'That is not a recording.' };
  const clean = steps
    .filter((s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y)))
    .map((s) => ({ x: Number(s.x), y: Number(s.y), dt: Math.max(0, Number(s.dt) || 0) }));
  if (!clean.length) return { ok: false, error: 'That recording has no steps.' };
  saveSteps(id, clean);
  push(id);
  return { ok: true, steps: clean.length };
}

/* ---- playback ------------------------------------------------------------
 * cfg comes from the settings panel:
 *   loops     0 = forever
 *   loopGap   seconds to wait between loops
 *   speed     divides every recorded gap; 2 = twice as fast
 *   fixedGap  >0 = ignore the recorded rhythm and use this gap throughout
 *
 * `from` lets one instance run another's recording, which is how a script
 * recorded on the original runs on every clone.
 * -------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stops responsively: a long gap is slept in slices so Stop does not have to
// wait out a five-minute pause before it is noticed.
async function interruptible(s, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (s.stopFlag) return false;
    await sleep(Math.min(250, until - Date.now()));
  }
  return !s.stopFlag;
}

async function play(id, cfg, opts) {
  const s = st(id);
  if (s.recording) return { ok: false, error: 'Stop recording first.' };
  if (s.playing) return { ok: true, already: true };

  const from = (opts && opts.from) ? Number(opts.from) : Number(id);
  const steps = loadSteps(from);
  if (!steps.length) {
    return { ok: false, error: from === Number(id) ? 'Nothing recorded on this instance yet.' : `Instance #${from} has no recording.` };
  }

  const c = cfg || {};
  const loops = Math.max(0, parseInt(c.loops, 10) || 0);
  const loopGap = Math.max(0, Number(c.loopGap) || 0);
  const speed = Math.max(0.1, Number(c.speed) || 1);
  const fixedGap = Math.max(0, Number(c.fixedGap) || 0);

  s.playing = true;
  s.stopFlag = false;
  s.loop = 0;
  s.step = 0;
  s.total = steps.length;
  s.msg = from === Number(id) ? '' : `Running instance #${from}'s recording.`;
  push(id);

  (async () => {
    try {
      for (let loop = 1; !s.stopFlag && (loops === 0 || loop <= loops); loop += 1) {
        s.loop = loop;
        for (let i = 0; i < steps.length; i += 1) {
          if (s.stopFlag) break;
          const step = steps[i];
          // The first step's recorded gap is the time before recording
          // started, which is meaningless, so it is never waited out.
          const gap = i === 0 ? 0 : (fixedGap > 0 ? fixedGap * 1000 : step.dt / speed);
          if (gap > 0 && !(await interruptible(s, gap))) break;
          if (s.stopFlag) break;
          s.step = i + 1;
          push(id);
          await android.tap(id, step.x, step.y);
        }
        if (s.stopFlag) break;
        const more = loops === 0 || loop < loops;
        if (more && loopGap > 0) {
          s.msg = `Loop ${loop} done — waiting ${loopGap}s.`;
          push(id);
          if (!(await interruptible(s, loopGap * 1000))) break;
          s.msg = '';
        }
      }
    } catch (e) {
      s.msg = String(e.message || e).slice(0, 200);
    } finally {
      s.playing = false;
      s.step = 0;
      if (!s.msg) s.msg = 'Stopped.';
      push(id);
    }
  })();

  return { ok: true, steps: steps.length };
}

function stop(id) {
  const s = st(id);
  s.stopFlag = true;
  if (!s.playing && !s.recording) return { ok: true };
  if (s.recording) return stopRecord(id);
  s.msg = 'Stopping…';
  push(id);
  return { ok: true };
}

function stopAll() {
  for (const id of live.keys()) stop(id);
  return { ok: true };
}

// One entry point for the UI, mirroring the browser version's command set so
// the buttons did not have to change.
function command(id, cmd, cfg, opts) {
  switch (String(cmd || '')) {
    case 'record': return record(id);
    case 'stopRecord': return stopRecord(id);
    case 'play': return play(id, cfg, opts);
    case 'stop': return stop(id);
    case 'clear': return clear(id);
    case 'state': return { ok: true, state: state(id) };
    case 'exportSteps': return exportSteps(id);
    case 'importSteps': return importSteps(id, opts && opts.steps);
    default: return { ok: false, error: `Unknown recorder command "${cmd}".` };
  }
}

// Which instances have a recording worth offering as a source.
function withRecordings(ids) {
  return (Array.isArray(ids) ? ids : []).filter((id) => loadSteps(id).length > 0).map(Number);
}

module.exports = {
  configure, command, state, noteTap, withRecordings,
  record, stopRecord, play, stop, stopAll, clear, exportSteps, importSteps, loadSteps,
  MAX_STEPS,
};
