/* ===========================================================================
 * Game instance preload — runs inside every instance, before the game's own
 * scripts. Two jobs: the "low graphics" knobs, and the click recorder.
 *
 * LOW GRAPHICS is the equivalent of an emulator's FPS / resolution settings,
 * except it costs nothing: there is no guest OS to turn down, just two
 * numbers the game itself reads.
 *
 *   FPS cap   — requestAnimationFrame is wrapped so the game's render loop is
 *               only *called* N times a second. Frames in between are skipped
 *               before any drawing happens, so the GPU work drops with it.
 *   Render DPR— window.devicePixelRatio is pinned low, so when the game sizes
 *               its WebGL drawing buffer it allocates a physically smaller
 *               one and the browser scales it up. Off by default: a game that
 *               sizes its own canvas from this value ends up letterboxed.
 *
 * THE RECORDER captures the clicks you make, then replays them on a loop.
 * Everything it records lives in the page's own storage, which is per
 * instance, so each one keeps its own routine and gets it back after a reload
 * or a restart — and one instance can never see another's.
 *
 * Everything is wrapped in try/catch: if something cannot be applied the game
 * simply runs as it would have.
 * ======================================================================== */
(function () {
  'use strict';

  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch (e) { ipc = null; }

  /* ======================================================================
   * Low graphics
   * ==================================================================== */
  const arg = (name, def) => {
    try {
      const hit = (process.argv || []).find((a) => a.startsWith(name + '='));
      const n = hit ? Number(hit.slice(name.length + 1)) : NaN;
      return Number.isFinite(n) ? n : def;
    } catch (e) { return def; }
  };

  // Two ways in, because an instance shows up in two places. A window gets
  // the numbers as launch arguments; a tile inside the dashboard is a
  // <webview>, which has no such thing, so it asks the main process. The ask
  // is synchronous on purpose: both overrides are worthless if they land
  // after the game's own scripts have already read these values.
  let fps = arg('--rca-fps', 0);
  let dpr = arg('--rca-dpr', 0);
  if (!fps && !dpr && ipc) {
    try {
      const t = ipc.sendSync('rca-game:tuning') || {};
      fps = Number(t.fps) || 0;
      dpr = Number(t.dpr) || 0;
    } catch (e) { /* no host listening — run at native speed */ }
  }

  // Both overrides have to live in the PAGE's own world, because it is the
  // page's requestAnimationFrame and devicePixelRatio the game reads. A
  // preload cannot touch those directly unless context isolation is off, and
  // a <webview> tile keeps it on no matter what the attribute asks for —
  // which is why the frame-rate cap silently did nothing in the dashboard.
  //
  // A <script> element added to the document always runs in the page's world,
  // isolated preload or not. So the override goes in as source text, at
  // document-start, before the game's own scripts get a chance to read either
  // value.
  function runInPage(source) {
    try {
      const el = document.createElement('script');
      el.textContent = source;
      (document.documentElement || document.head || document.body).appendChild(el);
      el.remove();
      return true;
    } catch (e) { return false; }
  }

  if (fps > 0 || dpr > 0) {
    runInPage(`(function () {
      var fps = ${Number(fps) || 0};
      var dpr = ${Number(dpr) || 0};
      if (dpr > 0) {
        try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: function () { return dpr; } }); } catch (e) {}
      }
      if (fps > 0) {
        try {
          var raf = window.requestAnimationFrame.bind(window);
          var minGap = 1000 / fps;
          var last = -Infinity;
          window.requestAnimationFrame = function (cb) {
            return raf(function (t) {
              // Too soon: re-queue without calling the game back, so the frame
              // is dropped before it draws anything.
              if (t - last < minGap) { window.requestAnimationFrame(cb); return; }
              last = t;
              cb(t);
            });
          };
        } catch (e) {}
      }
      try { window.__rcaGameTuned = { fps: fps, dpr: dpr, at: Date.now() }; } catch (e) {}
    })();`);
  } else {
    runInPage("try { window.__rcaGameTuned = { fps: 0, dpr: 0, at: Date.now() }; } catch (e) {}");
  }

  /* ======================================================================
   * Health heartbeat
   *
   * Counts the frames this instance actually paints and reports the rate once
   * a second. Both the counter and the report run on the page's own main
   * thread, so if the game seizes up the beat stops arriving — which is the
   * signal the dashboard needs to flag a frozen tile, and it cannot be faked
   * by a tab that is merely busy elsewhere.
   * ==================================================================== */
  (function health() {
    let frames = 0;
    let since = Date.now();
    const tick = () => {
      frames += 1;
      try { window.requestAnimationFrame(tick); } catch (e) { /* page gone */ }
    };
    try { window.requestAnimationFrame(tick); } catch (e) { /* ignore */ }
    // The login screen puts a real password field in the page; in game there
    // is none. So a password box that is actually on screen means this
    // instance has dropped back to the login — which is what "disconnected"
    // looks like from out here, whether the tile is being watched or not.
    const atLogin = () => {
      try {
        const p = document.querySelector('input[type="password"]');
        if (!p) return false;
        const r = p.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (e) { return false; }
    };

    setInterval(() => {
      const now = Date.now();
      const secs = Math.max(0.001, (now - since) / 1000);
      const beat = { fps: Math.round(frames / secs), at: now, atLogin: atLogin() };
      frames = 0;
      since = now;
      try { if (ipc && ipc.sendToHost) ipc.sendToHost('rca-game:health', beat); } catch (e) { /* not a tile */ }
      try { if (ipc) ipc.send('rca-game:health', beat); } catch (e) { /* not a window */ }
    }, 1000);
  })();

  /* ======================================================================
   * Click recorder
   * ==================================================================== */
  const KEY = '__rcaClickRec';
  const MAX_STEPS = 2000;        // a routine, not an endless log

  let steps = [];
  let recording = false;
  let playing = false;
  let timer = null;
  let loopsDone = 0;
  let badge = null;
  let cfg = { loops: 0, loopGap: 1, speed: 1, fixedGap: 0 };

  function loadSteps() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
      steps = Array.isArray(raw.steps) ? raw.steps : [];
    } catch (e) { steps = []; }
  }
  function saveSteps() {
    try { localStorage.setItem(KEY, JSON.stringify({ steps })); } catch (e) { /* ignore */ }
  }

  // Tell the app what this instance is doing, so the buttons can reflect it.
  function report() {
    const state = { steps: steps.length, recording, playing, loopsDone };
    try { if (ipc && ipc.sendToHost) ipc.sendToHost('rca-game:clickState', state); } catch (e) { /* not a tile */ }
    try { if (ipc) ipc.send('rca-game:clickState', state); } catch (e) { /* not a window */ }
    paintBadge();
  }

  function paintBadge() {
    try {
      if (!badge) {
        badge = document.createElement('div');
        badge.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;pointer-events:none;'
          + 'font:600 11px system-ui,sans-serif;padding:3px 8px;border-radius:999px;'
          + 'background:rgba(5,13,24,.85);color:#e7f1fb;border:1px solid #1c3149';
        (document.body || document.documentElement).appendChild(badge);
      }
      let text = '';
      let tone = '#1c3149';
      if (recording) {
        text = '● recording · ' + steps.length;
        tone = '#ff5a6e';
      } else if (playing) {
        text = '▶ playing · ' + steps.length + ' clicks · loop '
          + (loopsDone + 1) + (cfg.loops ? '/' + cfg.loops : '');
        tone = '#22d07a';
      } else if (steps.length) {
        text = steps.length + ' clicks recorded';
      }
      badge.textContent = text;
      badge.style.borderColor = tone;
      badge.style.display = text ? 'block' : 'none';
    } catch (e) { /* ignore */ }
  }

  // A full press-and-release at a point, on whatever is topmost there. Canvas
  // games listen for pointer and mouse events rather than anything clickable,
  // so a bare .click() would do nothing.
  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y) || document.body;
    if (!el) return;
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 };
    const ptr = (type, buttons) => {
      try { el.dispatchEvent(new PointerEvent(type, { ...base, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true })); }
      catch (e) { /* older engines */ }
    };
    try { el.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
    ptr('pointerdown', 1);
    try { el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 })); } catch (e) { /* ignore */ }
    ptr('pointerup', 0);
    try { el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
    try { el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
    // Text fields do not take focus from a dispatched click the way they do
    // from a real one, so ask for it directly when the target can hold it.
    try {
      if (el.focus && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '')) el.focus();
    } catch (e) { /* ignore */ }
  }

  /* ---- recording -------------------------------------------------------- */
  let lastAt = 0;

  function onRealClick(ev) {
    if (!recording) return;
    if (steps.length >= MAX_STEPS) { stopRecording(); return; }
    const now = Date.now();
    steps.push({
      x: Math.round(ev.clientX),
      y: Math.round(ev.clientY),
      dt: steps.length ? Math.min(60000, now - lastAt) : 0,
    });
    lastAt = now;
    saveSteps();
    report();
  }

  function startRecording() {
    stopPlaying();
    steps = [];
    saveSteps();
    recording = true;
    lastAt = Date.now();
    report();
  }

  function stopRecording() {
    recording = false;
    saveSteps();
    report();
  }

  /* ---- playback --------------------------------------------------------- */
  function stopPlaying() {
    playing = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function play() {
    if (!steps.length) { report(); return; }
    stopRecording();
    stopPlaying();
    playing = true;
    loopsDone = 0;
    runStep(0);
    report();
  }

  function runStep(i) {
    if (!playing) return;
    if (i >= steps.length) {
      loopsDone += 1;
      if (cfg.loops && loopsDone >= cfg.loops) { stopPlaying(); report(); return; }
      report();
      timer = setTimeout(() => runStep(0), Math.max(0, (Number(cfg.loopGap) || 0) * 1000));
      return;
    }
    const step = steps[i];
    // Either keep the rhythm that was recorded, or ignore it and use one
    // fixed gap for every click.
    const speed = Math.max(0.1, Number(cfg.speed) || 1);
    const gap = cfg.fixedGap > 0
      ? cfg.fixedGap * 1000
      : (i === 0 ? 0 : (Number(step.dt) || 0) / speed);
    timer = setTimeout(() => {
      if (!playing) return;
      clickAt(step.x, step.y);
      paintBadge();
      runStep(i + 1);
    }, Math.max(0, Math.min(120000, gap)));
  }

  /* ---- commands from the app -------------------------------------------- */
  if (ipc) {
    try {
      ipc.on('rca-game:click', (_e, msg) => {
        const m = msg || {};
        if (m.cfg) cfg = { ...cfg, ...m.cfg };
        switch (m.cmd) {
          case 'record': startRecording(); break;
          case 'stopRecord': stopRecording(); break;
          case 'play': play(); break;
          case 'stop': stopPlaying(); report(); break;
          case 'clear': stopPlaying(); stopRecording(); steps = []; saveSteps(); report(); break;
          case 'state': report(); break;
          // Hand this instance's routine out, so one recording can be copied
          // to every other instance instead of being made again in each.
          case 'exportSteps':
            try { if (ipc.sendToHost) ipc.sendToHost('rca-game:steps', { steps }); } catch (e) { /* not a tile */ }
            try { ipc.send('rca-game:steps', { steps }); } catch (e) { /* not a window */ }
            break;
          case 'importSteps':
            stopPlaying();
            stopRecording();
            steps = Array.isArray(m.steps) ? m.steps.slice(0, MAX_STEPS) : [];
            saveSteps();
            report();
            break;
          default: break;
        }
      });
    } catch (e) { /* ignore */ }
  }

  try {
    window.addEventListener('pointerdown', onRealClick, true);
    const ready = () => { loadSteps(); report(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
  } catch (e) { /* ignore */ }
})();
