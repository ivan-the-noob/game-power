/* ===========================================================================
 * Game Power — the dashboard.
 *
 * Every instance as a live tile inside ONE window. An instance is a headless
 * Android guest, so a tile is not a window: it is a stream of PNG frames
 * pulled over ADB. That is deliberate — a headless emulator allocates no host
 * display surface at all, which is the floor for GPU cost, and embedding a
 * foreign top-level window into Electron would need a native addon.
 *
 * Frames are fetched by ONE serial pump, never a timer per tile. Six tiles
 * each firing their own screencap would queue six adb processes against six
 * virtual machines and fall further behind every second; a single loop that
 * takes one frame at a time is self-limiting and always current.
 *
 * Clicks go the other way: a click on a tile becomes a real ADB tap, scaled
 * from the tile's size to the guest's screen. Android cannot tell it from a
 * finger, which is the thing the browser version could never manage.
 * ======================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let cfg = null;                 // { settings, groups, rows }
  const tiles = new Map();        // id -> tile record
  let expandedId = null;
  let pumping = false;

  const settings = () => (cfg && cfg.settings) || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- layout -------------------------------------------------------------
   * Fixed mode is the default and matches a multi-instance manager: every tile
   * keeps the exact size you set, and the grid wraps and scrolls.
   * ------------------------------------------------------------------------ */
  const LS = 'gamepower.stage.layout';
  // Bumped when the default shape changes, so old saved defaults get replaced
  // rather than kept. v3 = landscape 800x480 guests.
  const LAYOUT_V = 3;

  function readLayout() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { saved = {}; }
    if (Number(saved.v) !== LAYOUT_V) return { w: 400, h: 272, fixed: true };
    return { w: Number(saved.w) || 400, h: Number(saved.h) || 272, fixed: saved.fixed !== false };
  }

  function saveLayout(l) {
    try { localStorage.setItem(LS, JSON.stringify({ ...l, v: LAYOUT_V })); } catch (e) { /* ignore */ }
  }

  function applyLayout() {
    const grid = $('grid');
    const w = Math.max(180, Number($('tileW').value) || 400);
    const h = Math.max(140, Number($('tileH').value) || 272);
    const fixed = $('fixedSize').checked;
    saveLayout({ w, h, fixed });

    if (expandedId) {
      grid.classList.add('expanded');
      grid.classList.remove('fixed');
      grid.style.gridTemplateColumns = '';
      for (const t of tiles.values()) { t.el.style.width = ''; t.el.style.height = ''; }
      return;
    }
    grid.classList.remove('expanded');
    grid.classList.toggle('fixed', fixed);
    if (fixed) {
      grid.style.gridTemplateColumns = `repeat(auto-fill, ${w}px)`;
      for (const t of tiles.values()) { t.el.style.width = w + 'px'; t.el.style.height = h + 'px'; }
    } else {
      const n = tiles.size || 1;
      const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (window.innerWidth / Math.max(1, window.innerHeight - 44)) * (h / w)))));
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      for (const t of tiles.values()) { t.el.style.width = ''; t.el.style.height = ''; }
    }
  }

  /* ---- tiles ------------------------------------------------------------ */
  function buildTile(row) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.id = row.id;
    el.innerHTML = `
      <div class="tile-head">
        <span class="tile-id">#${row.id}</span>
        <span class="tile-name">${esc(row.name)}${row.original ? ' ★' : ''}</span>
        <span class="tile-stat" data-stat>stopped</span>
        <span class="tile-btns">
          <button data-act="hide" title="Stop drawing this view. The instance keeps running — it just stops costing a screen capture every cycle.">👁</button>
          <button data-act="record" title="Record every tap you make on this tile, until you press it again">●</button>
          <button data-act="play" title="Replay this instance's recording on a loop">▶</button>
          <button data-act="expand" title="Fill the window with this one, at a higher frame rate">⤢</button>
          <button data-act="restart" title="Force-stop the game and start it again">↻</button>
          <button data-act="stop" title="Shut this instance down. Its data is kept.">✕</button>
        </span>
      </div>
      <div class="tile-body">
        <img class="tile-screen" alt="" draggable="false" hidden />
        <div class="tile-idle">
          <span data-idle>Stopped</span>
          <button data-act="start" class="primary">▶ Start</button>
        </div>
      </div>`;
    const tile = {
      row,
      el,
      body: el.querySelector('.tile-body'),
      img: el.querySelector('.tile-screen'),
      idle: el.querySelector('.tile-idle'),
      idleText: el.querySelector('[data-idle]'),
      statEl: el.querySelector('[data-stat]'),
      url: null,
      status: 'stopped',
      hidden: false,
      rec: {},
      frames: 0,
    };
    tiles.set(row.id, tile);
    return el;
  }

  /* ---- the frame pump ----------------------------------------------------
   * One loop for the whole dashboard. Who gets frames:
   *   - zoomed in: only that tile, at zoomFps
   *   - otherwise: every visible, non-hidden, ready tile at tileFps
   * A cycle that takes longer than its budget simply runs slower, which is the
   * correct behaviour when the machine is busy.
   * ---------------------------------------------------------------------- */
  function targets() {
    if (expandedId) {
      const t = tiles.get(expandedId);
      return t && t.status === 'ready' && !t.hidden ? [t] : [];
    }
    return [...tiles.values()].filter((t) => (
      t.status === 'ready' && !t.hidden && t.el.style.display !== 'none'
    ));
  }

  async function grab(t) {
    let r = null;
    try { r = await window.stage.frame(t.row.id); } catch (e) { r = null; }
    if (!r || !r.ok || !r.png) return;
    const url = URL.createObjectURL(new Blob([r.png], { type: 'image/png' }));
    const old = t.url;
    // Revoke the previous frame only once the new one is decoded, or the tile
    // flickers to blank between frames.
    t.img.onload = () => { if (old) URL.revokeObjectURL(old); };
    t.img.src = url;
    t.url = url;
    t.img.hidden = false;
    t.idle.style.display = 'none';
    t.frames += 1;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (pumping) {
      const list = targets();
      if (!list.length) { await sleep(400); continue; }
      const fps = expandedId
        ? Math.max(1, Number(settings().zoomFps) || 5)
        : Math.max(0.2, Number(settings().tileFps) || 1);
      const budget = 1000 / fps;          // how long a full cycle may take
      const t0 = performance.now();
      for (const t of list) {
        if (!pumping) break;
        await grab(t);
      }
      await sleep(Math.max(0, budget - (performance.now() - t0)));
    }
  }

  /* ---- hiding ------------------------------------------------------------
   * A hidden tile is NOT stopped: the guest keeps running, stays logged in and
   * keeps replaying its recording. It just stops being captured — and unlike
   * the browser version, where hiding only saved compositing, here it removes
   * a real screen capture per cycle.
   * ---------------------------------------------------------------------- */
  function setHidden(id, hidden) {
    const t = tiles.get(Number(id));
    if (!t) return;
    t.hidden = !!hidden;
    let veil = t.body.querySelector('.tile-veil');
    if (t.hidden) {
      t.img.hidden = true;
      if (!veil) {
        veil = document.createElement('div');
        veil.className = 'tile-veil';
        veil.innerHTML = '<span class="veil-eye">👁</span><span>Hidden · still running</span>';
        t.body.appendChild(veil);
      }
    } else {
      if (veil) veil.remove();
      if (t.url) t.img.hidden = false;
    }
    const btn = t.el.querySelector('button[data-act="hide"]');
    if (btn) { btn.textContent = t.hidden ? '🚫' : '👁'; btn.style.color = t.hidden ? 'var(--amber)' : ''; }
    t.el.classList.toggle('is-hidden', t.hidden);
  }

  function setExpanded(id) {
    expandedId = id ? Number(id) : null;
    for (const [tid, t] of tiles) t.el.classList.toggle('dim', expandedId !== null && tid !== expandedId);
    $('zoomBar').hidden = !expandedId;
    applyLayout();
  }

  /* ---- input -------------------------------------------------------------
   * A click inside a tile is a tap on that guest. The tile may be any size, so
   * the position is sent as a fraction and scaled in the main process against
   * the guest's real framebuffer. A drag becomes a swipe.
   * ---------------------------------------------------------------------- */
  function normFrom(t, ev) {
    // Measure against the IMAGE, not the tile: the frame is letterboxed inside
    // the tile when their shapes differ, so the tile's own box would skew
    // every coordinate.
    const r = t.img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const nx = (ev.clientX - r.left) / r.width;
    const ny = (ev.clientY - r.top) / r.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { nx, ny };
  }

  const DRAG_MIN = 0.03;   // below this, a drag is just an imprecise tap
  let down = null;

  $('grid').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const img = e.target.closest('.tile-screen');
    if (!img) return;
    const t = tiles.get(Number(img.closest('.tile').dataset.id));
    if (!t || t.status !== 'ready') return;
    const n = normFrom(t, e);
    if (!n) return;
    down = { t, from: n, at: Date.now() };
  });

  window.addEventListener('pointerup', async (e) => {
    const d = down;
    down = null;
    if (!d) return;
    const n = normFrom(d.t, e) || d.from;
    const dx = Math.abs(n.nx - d.from.nx);
    const dy = Math.abs(n.ny - d.from.ny);
    const id = d.t.row.id;
    try {
      if (dx > DRAG_MIN || dy > DRAG_MIN) {
        await window.stage.swipe(id, d.from.nx, d.from.ny, n.nx, n.ny, Math.min(900, Math.max(80, Date.now() - d.at)));
      } else {
        await window.stage.tap(id, d.from.nx, d.from.ny);
      }
    } catch (err) { /* a tap that misses is not worth a dialog */ }
  });

  // Typing reaches the zoomed guest, which is how you get through a login.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (expandedId) setExpanded(null); return; }
    if (!expandedId) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const id = expandedId;
    if (e.key === 'Backspace') { e.preventDefault(); window.stage.key(id, 'KEYCODE_DEL'); return; }
    if (e.key === 'Enter') { e.preventDefault(); window.stage.key(id, 'KEYCODE_ENTER'); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      window.stage.text(id, e.key);
    }
  });

  /* ---- live numbers ----------------------------------------------------- */
  function words(m) {
    if (!m) return 'stopped';
    if (m.status === 'booting') return 'booting…';
    if (m.status === 'error') return 'failed';
    if (m.status === 'stopped') return 'stopped';
    return 'ready';
  }

  async function poll() {
    const r = await window.stage.metrics().catch(() => null);
    if (!r || !r.ok) return;
    const byId = new Map(r.rows.map((x) => [Number(x.id), x]));
    let running = 0;
    let totalMB = 0;
    for (const t of tiles.values()) {
      const m = byId.get(Number(t.row.id));
      const was = t.status;
      t.status = m ? m.status : 'stopped';
      if (m && m.alive) { running += 1; totalMB += m.ramMB; }

      // Leaving ready means the picture is stale; drop it rather than show a
      // frozen frame as if it were live.
      if (was === 'ready' && t.status !== 'ready') {
        t.img.hidden = true;
        t.idle.style.display = '';
        if (t.url) { URL.revokeObjectURL(t.url); t.url = null; }
      }
      t.el.classList.toggle('live', t.status === 'ready');
      t.el.classList.toggle('offline', t.status === 'error');

      const label = words(m);
      t.statEl.textContent = m && m.alive ? `${m.ramMB} MB · ${m.cpu}% · ${label}` : label;
      t.statEl.className = 'tile-stat' + (m && m.ramMB > 1400 ? ' max' : m && m.ramMB > 900 ? ' hot' : '');
      t.idleText.textContent = (m && m.note) ? m.note : (label === 'ready' ? 'Waiting for the first frame…' : label);
      if (t.status !== 'ready') t.idle.style.display = '';
    }
    const freeGB = (r.hostFreeMB / 1024).toFixed(1);
    $('stageSum').textContent = running
      ? `${running} of ${tiles.size} running · ${totalMB} MB in guests · ${freeGB} GB RAM free`
      : `${tiles.size} instance${tiles.size === 1 ? '' : 's'} · none running · ${freeGB} GB RAM free`;
  }

  /* ---- the click recorder ------------------------------------------------
   * The recorder lives in the main process, so the dashboard and the control
   * panel drive the very same recording — and a tap recorded here is the exact
   * tap the guest received.
   * ---------------------------------------------------------------------- */
  const send = (id, cmd, opts) => window.stage.clickCmd(id, cmd, opts).catch(() => null);

  function paintRec(id) {
    const t = tiles.get(Number(id));
    if (!t) return;
    const r = t.rec || {};
    const recBtn = t.el.querySelector('button[data-act="record"]');
    const playBtn = t.el.querySelector('button[data-act="play"]');
    if (recBtn) { recBtn.textContent = r.recording ? '■' : '●'; recBtn.style.color = r.recording ? 'var(--red)' : ''; }
    if (playBtn) { playBtn.textContent = r.playing ? '⏹' : '▶'; playBtn.style.color = r.playing ? 'var(--green)' : ''; }
    t.el.classList.toggle('recording', !!r.recording);
  }

  window.stage.onClickState((s) => {
    const t = tiles.get(Number(s && s.id));
    if (!t) return;
    t.rec = s || {};
    paintRec(t.row.id);
  });

  /* ---- events ----------------------------------------------------------- */
  $('grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tileEl = btn.closest('.tile');
    if (!tileEl) return;
    const id = Number(tileEl.dataset.id);
    const t = tiles.get(id);
    const act = btn.dataset.act;
    if (act === 'start') { t.idleText.textContent = 'starting…'; window.stage.start(id).then(poll); }
    else if (act === 'stop') { window.stage.stop(id).then(poll); if (expandedId === id) setExpanded(null); }
    else if (act === 'restart') window.stage.restartApp(id);
    else if (act === 'hide') setHidden(id, !(t && t.hidden));
    else if (act === 'record') send(id, (t && t.rec && t.rec.recording) ? 'stopRecord' : 'record');
    else if (act === 'play') send(id, (t && t.rec && t.rec.playing) ? 'stop' : 'play');
    else if (act === 'expand') setExpanded(expandedId === id ? null : id);
  });

  // Clicking the title strip zooms. The body is the live guest, so a click
  // there has to reach Android, not the dashboard.
  $('grid').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const head = e.target.closest('.tile-head');
    if (!head) return;
    const id = Number(head.closest('.tile').dataset.id);
    setExpanded(expandedId === id ? null : id);
  });

  /* ---- the zoom bar: Android's own buttons -------------------------------- */
  $('zoomBar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn || !expandedId) return;
    window.stage.key(expandedId, btn.dataset.key);
  });

  /* ---- toolbar ------------------------------------------------------------ */
  $('startAllTiles').addEventListener('click', async () => {
    // Serially: several cold boots launched at once fight for the same cores
    // and all of them take longer than they would one after another.
    for (const id of tiles.keys()) {
      await window.stage.start(id).catch(() => null);
      await sleep(2500);
    }
    poll();
  });

  $('stopAllTiles').addEventListener('click', async () => {
    for (const id of tiles.keys()) await window.stage.stop(id).catch(() => null);
    setExpanded(null);
    poll();
  });

  $('hideAllTiles').addEventListener('click', () => { for (const id of tiles.keys()) setHidden(id, true); });
  $('showAllTiles').addEventListener('click', () => { for (const id of tiles.keys()) setHidden(id, false); });

  $('playAllBtn').addEventListener('click', async () => {
    // Record once on the original, run it everywhere: `from` replays another
    // instance's recording rather than copying it around.
    const src = Number($('recFrom').value) || null;
    let n = 0;
    for (const t of tiles.values()) {
      if (t.status !== 'ready') continue;
      const opts = src && src !== t.row.id ? { from: src } : undefined;
      const r = await send(t.row.id, 'play', opts);
      if (r && r.ok) n += 1;
    }
    if (!n) alert('No instance is ready, or nothing is recorded yet.');
  });

  $('stopAllRecBtn').addEventListener('click', () => { for (const id of tiles.keys()) send(id, 'stop'); });

  async function refreshRecSources() {
    const r = await window.stage.recSources().catch(() => null);
    const ids = (r && r.ok ? r.ids : []) || [];
    const sel = $('recFrom');
    const keep = sel.value;
    sel.innerHTML = '<option value="">each its own</option>'
      + ids.map((id) => {
        const t = tiles.get(Number(id));
        return `<option value="${id}">#${id} ${esc(t ? t.row.name : '')}</option>`;
      }).join('');
    if (keep && ids.includes(Number(keep))) sel.value = keep;
  }

  /* ---- group filter ------------------------------------------------------- */
  function applyGroupFilter() {
    const want = $('groupSel').value || '';
    for (const t of tiles.values()) {
      t.el.style.display = (!want || (t.row.group || '') === want) ? '' : 'none';
    }
    applyLayout();
  }
  $('groupSel').addEventListener('change', applyGroupFilter);

  ['tileW', 'tileH', 'fixedSize'].forEach((id) => $(id).addEventListener('input', applyLayout));
  window.addEventListener('resize', applyLayout);
  window.addEventListener('beforeunload', () => { pumping = false; });

  /* ---- go --------------------------------------------------------------- */
  (async function start() {
    cfg = await window.stage.data().catch(() => null);
    const grid = $('grid');
    if (!cfg || !cfg.ok || !cfg.rows.length) {
      grid.innerHTML = '<div class="stage-empty">No instances yet. Create them in the control panel first.</div>';
      return;
    }
    const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    $('groupSel').innerHTML = '<option value="">All</option>'
      + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');

    const l = readLayout();
    $('tileW').value = l.w;
    $('tileH').value = l.h;
    $('fixedSize').checked = l.fixed;

    grid.innerHTML = '';
    for (const row of cfg.rows) grid.appendChild(buildTile(row));
    applyLayout();

    // Unlike the browser version, tiles are NOT all started on open: each one
    // is a virtual machine, and starting six at once on a six-core machine just
    // makes all six boot slowly. Start them from the toolbar, or one by one.
    for (const id of tiles.keys()) {
      send(id, 'state').then((r) => {
        if (r && r.ok && r.state) { tiles.get(id).rec = r.state; paintRec(id); }
      });
    }

    await poll();
    pump();
    setInterval(() => { if (!document.hidden) poll(); }, 2000);
    setInterval(refreshRecSources, 10000);
    refreshRecSources();
  })();
})();
