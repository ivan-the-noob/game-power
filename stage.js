/* ===========================================================================
 * Game Power — the dashboard.
 *
 * Every instance as a live tile inside ONE window instead of a browser window
 * loose on the desktop. Each tile is a <webview> bound to that instance's own
 * session partition, so it is the same instance either way: same login, same
 * cookies, same downloaded asset packs.
 *
 * The RAM and CPU on each tile come from the main process reading Chromium's
 * per-process accounting for that tile's own renderer, so a tile costs what it
 * says it costs.
 * ======================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let cfg = null;                 // { settings, ua, rows, preloadUrl }
  const tiles = new Map();        // id -> { row, el, body, wv, wcId, statEl }
  let expandedId = null;

  /* ---- layout -------------------------------------------------------------
   * Fixed mode is the default and matches a multi-instance manager: every tile
   * keeps the exact size you set, and the grid wraps and scrolls. Turn Fixed
   * off and the tiles stretch to fill the window instead.
   * ------------------------------------------------------------------------ */
  const LS = 'gamepower.stage.layout';

  // Landscape by default: the game declares orientation "landscape" in its own
  // manifest, so a portrait tile letterboxes it with black. The version stamp
  // is here so the first portrait defaults get replaced rather than kept.
  const LAYOUT_V = 2;

  function readLayout() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { saved = {}; }
    if (Number(saved.v) !== LAYOUT_V) return { w: 480, h: 300, fixed: true };
    return {
      w: Number(saved.w) || 480,
      h: Number(saved.h) || 300,
      fixed: saved.fixed !== false,
    };
  }

  function saveLayout(l) {
    try { localStorage.setItem(LS, JSON.stringify({ ...l, v: LAYOUT_V })); } catch (e) { /* ignore */ }
  }

  function applyLayout() {
    const grid = $('grid');
    const w = Math.max(180, Number($('tileW').value) || 480);
    const h = Math.max(160, Number($('tileH').value) || 300);
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
        <span class="tile-name">${esc(row.name)}</span>
        <span class="tile-stat" data-stat>idle</span>
        <span class="tile-btns">
          <button data-act="hide" title="Hide this view. The instance keeps running — hiding just stops it being drawn, which is what frees the frame rate.">👁</button>
          <button data-act="record" title="Record every click you make in this tile, until you press it again">●</button>
          <button data-act="play" title="Replay the recording on a loop">▶</button>
          <button data-act="expand" title="Fill the window with this one">⤢</button>
          <button data-act="reload" title="Reload">↻</button>
          <button data-act="unload" title="Unload — frees its memory, keeps its data">✕</button>
        </span>
      </div>
      <div class="tile-body">
        <div class="tile-idle">
          <span>Not loaded</span>
          <button data-act="load" class="primary">▶ Load</button>
        </div>
      </div>`;
    const tile = { row, el, body: el.querySelector('.tile-body'), statEl: el.querySelector('[data-stat]'), wv: null, wcId: null };
    tiles.set(row.id, tile);
    return el;
  }

  function load(id) {
    const t = tiles.get(Number(id));
    if (!t || t.wv) return;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', t.row.partition);
    wv.setAttribute('preload', cfg.preloadUrl);
    wv.setAttribute('src', cfg.settings.url);
    wv.setAttribute('allowpopups', '');
    // The tuning preload has to reach the page's own requestAnimationFrame and
    // devicePixelRatio, which is exactly what context isolation prevents. The
    // tile stays sandboxed with no Node integration, so the page gains nothing.
    wv.setAttribute('webpreferences', 'contextIsolation=no,sandbox=yes,nodeIntegration=no,spellcheck=no');
    if (cfg.ua) wv.setAttribute('useragent', cfg.ua);

    wv.addEventListener('ipc-message', (ev) => {
      if (ev.channel === 'rca-game:health') { t.health = ev.args && ev.args[0]; return; }
      if (ev.channel === 'rca-game:steps') { spreadSteps((ev.args && ev.args[0] && ev.args[0].steps) || []); return; }
      if (ev.channel !== 'rca-game:clickState') return;
      t.rec = ev.args && ev.args[0] ? ev.args[0] : {};
      paintRec(t.row.id);
    });
    wv.addEventListener('dom-ready', () => {
      try { t.wcId = wv.getWebContentsId(); } catch (e) { t.wcId = null; }
      try { wv.setAudioMuted(!!cfg.settings.muted); } catch (e) { /* ignore */ }
    });
    // Anything the game tries to open in a new window stays in the tile.
    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      try { wv.loadURL(e.url); } catch (err) { /* ignore */ }
    });

    t.body.innerHTML = '';
    t.body.appendChild(wv);
    t.wv = wv;
    t.el.classList.add('live');
    if (t.hidden) setHidden(t.row.id, true);
    t.statEl.textContent = 'loading…';
  }

  function unload(id) {
    const t = tiles.get(Number(id));
    if (!t || !t.wv) return;
    try { t.wv.remove(); } catch (e) { /* ignore */ }
    t.wv = null;
    t.wcId = null;
    t.rec = {};
    paintRec(t.row.id);
    t.el.classList.remove('live');
    t.statEl.textContent = 'idle';
    t.body.innerHTML = '<div class="tile-idle"><span>Not loaded</span><button data-act="load" class="primary">▶ Load</button></div>';
    if (expandedId === Number(id)) setExpanded(null);
  }

  /* ---- hiding ------------------------------------------------------------
   * A hidden tile is NOT closed: the game keeps running, stays logged in and
   * keeps replaying its recording. It simply stops being painted, and a view
   * that is not painted costs nothing to composite — which is the whole
   * reason a wall of live tiles drags and a single expanded one does not.
   * ---------------------------------------------------------------------- */
  function setHidden(id, hidden) {
    const t = tiles.get(Number(id));
    if (!t) return;
    t.hidden = !!hidden;
    if (t.wv) t.wv.style.display = t.hidden ? 'none' : '';
    let veil = t.body.querySelector('.tile-veil');
    if (t.hidden) {
      if (!veil) {
        veil = document.createElement('div');
        veil.className = 'tile-veil';
        veil.innerHTML = '<span class="veil-eye">👁</span><span>Hidden · still running</span>';
        t.body.appendChild(veil);
      }
    } else if (veil) { veil.remove(); }
    const btn = t.el.querySelector('button[data-act="hide"]');
    if (btn) { btn.textContent = t.hidden ? '🚫' : '👁'; btn.style.color = t.hidden ? 'var(--amber)' : ''; }
    t.el.classList.toggle('is-hidden', t.hidden);
  }

  function setExpanded(id) {
    expandedId = id ? Number(id) : null;
    for (const [tid, t] of tiles) t.el.classList.toggle('dim', expandedId !== null && tid !== expandedId);
    applyLayout();
    // Zooming in on an instance usually means you want to play it.
    if (expandedId) {
      const t = tiles.get(expandedId);
      if (t && t.wv) { try { t.wv.focus(); } catch (e) { /* ignore */ } }
    }
  }

  /* ---- live numbers ----------------------------------------------------- */
  async function poll() {
    const ids = [...tiles.values()].filter((t) => t.wcId).map((t) => t.wcId);
    let loadedCount = 0;
    let totalMB = 0;
    if (ids.length) {
      const r = await window.stage.metrics(ids).catch(() => null);
      const byId = new Map((r && r.ok ? r.rows : []).map((x) => [x.wcId, x]));
      for (const t of tiles.values()) {
        if (!t.wcId) continue;
        const m = byId.get(t.wcId);
        if (!m) { t.statEl.textContent = '…'; continue; }
        loadedCount += 1;
        totalMB += m.ramMB;
        // Say what the instance is doing in words. A hidden tile is supposed
        // to stop painting, so it is never called stuck — but it can still
        // drop back to the login screen, and that is worth knowing even while
        // you are not looking at it.
        const h = t.health;
        const stale = !h || (Date.now() - h.at) > 5000;
        const gone = !!(h && h.atLogin);
        let label;
        if (t.hidden) label = gone ? 'hidden · disconnected' : 'hidden';
        else if (gone) label = 'disconnected';
        else if (stale) label = 'no frames';
        else label = h.fps + ' fps';
        t.el.classList.toggle('offline', gone || (!t.hidden && stale));
        t.statEl.textContent = m.ramMB + ' MB · ' + label;
        t.statEl.className = 'tile-stat' + (m.ramMB > 700 ? ' max' : m.ramMB > 400 ? ' hot' : '');
      }
    }
    $('stageSum').textContent = loadedCount
      ? `${loadedCount} of ${tiles.size} loaded · ${totalMB} MB in tiles`
      : `${tiles.size} instance${tiles.size === 1 ? '' : 's'} · none loaded`;
  }

  /* ---- events ----------------------------------------------------------- */
  $('grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tileEl = btn.closest('.tile');
    if (!tileEl) return;
    const id = Number(tileEl.dataset.id);
    const act = btn.dataset.act;
    if (act === 'load') load(id);
    else if (act === 'hide') { const t = tiles.get(id); setHidden(id, !(t && t.hidden)); }
    else if (act === 'record') { const t = tiles.get(id); sendClick(id, (t && t.rec && t.rec.recording) ? 'stopRecord' : 'record'); }
    else if (act === 'play') { const t = tiles.get(id); sendClick(id, (t && t.rec && t.rec.playing) ? 'stop' : 'play'); }
    else if (act === 'unload') unload(id);
    else if (act === 'reload') { const t = tiles.get(id); if (t && t.wv) { try { t.wv.reload(); } catch (err) { /* ignore */ } } }
    else if (act === 'expand') setExpanded(expandedId === id ? null : id);
  });

  // Clicking a tile's title strip zooms it. The tile body itself is the live
  // game, so a click in there has to reach the game, not the dashboard.
  $('grid').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const head = e.target.closest('.tile-head');
    if (!head) return;
    const id = Number(head.closest('.tile').dataset.id);
    setExpanded(expandedId === id ? null : id);
  });

  /* ---- click recorder ----------------------------------------------------
   * Recording and replaying both happen inside the tile (game-preload.js);
   * this only sends the command and shows what the tile reports back.
   * ---------------------------------------------------------------------- */
  function playbackCfg() {
    const st = (cfg && cfg.settings) || {};
    return {
      loops: Math.max(0, parseInt(st.recLoops, 10) || 0),
      loopGap: Math.max(0, (Number(st.recLoopGapMin) || 0) * 60 + (Number(st.recLoopGap) || 0)),
      speed: Math.max(0.1, Number(st.recSpeed) || 1),
      fixedGap: Math.max(0, Number(st.recFixedGap) || 0),
    };
  }

  function sendClick(id, cmd) {
    const t = tiles.get(Number(id));
    if (!t || !t.wv) return false;
    try { t.wv.send('rca-game:click', { cmd, cfg: playbackCfg() }); } catch (e) { return false; }
    return true;
  }

  function paintRec(id) {
    const t = tiles.get(Number(id));
    if (!t) return;
    const r = t.rec || {};
    const recBtn = t.el.querySelector('button[data-act="record"]');
    const playBtn = t.el.querySelector('button[data-act="play"]');
    if (recBtn) { recBtn.textContent = r.recording ? '■' : '●'; recBtn.style.color = r.recording ? 'var(--red)' : ''; }
    if (playBtn) { playBtn.textContent = r.playing ? '⏹' : '▶'; playBtn.style.color = r.playing ? 'var(--green)' : ''; }
  }

  $('clickAllBtn').addEventListener('click', () => { for (const id of tiles.keys()) sendClick(id, 'play'); });
  $('clickStopBtn').addEventListener('click', () => { for (const id of tiles.keys()) sendClick(id, 'stop'); });

  /* ---- one recording, every instance -------------------------------------
   * Ask the first loaded tile for its routine, then hand that same routine to
   * every other loaded tile. Record once rather than once per clone.
   * ---------------------------------------------------------------------- */
  let copyFrom = null;

  $('copyRecBtn').addEventListener('click', () => {
    const loaded = [...tiles.values()].filter((t) => t.wv);
    if (loaded.length < 2) { alert('Load at least two instances first.'); return; }
    copyFrom = loaded[0];
    sendClick(copyFrom.row.id, 'exportSteps');
  });

  function spreadSteps(steps) {
    if (!copyFrom) return;
    const src = copyFrom;
    copyFrom = null;
    if (!steps || !steps.length) { alert(`#${src.row.id} ${src.row.name} has nothing recorded yet.`); return; }
    let n = 0;
    for (const t of tiles.values()) {
      if (!t.wv || t === src) continue;
      try { t.wv.send('rca-game:click', { cmd: 'importSteps', steps, cfg: playbackCfg() }); n += 1; } catch (e) { /* ignore */ }
    }
    alert(`Copied ${steps.length} clicks from #${src.row.id} ${src.row.name} to ${n} other instance${n === 1 ? '' : 's'}.`);
  }

  /* ---- group filter ------------------------------------------------------- */
  function applyGroupFilter() {
    const want = $('groupSel').value || '';
    for (const t of tiles.values()) {
      const show = !want || (t.row.group || '') === want;
      t.el.style.display = show ? '' : 'none';
    }
    applyLayout();
  }
  $('groupSel').addEventListener('change', applyGroupFilter);

  $('hideAllTiles').addEventListener('click', () => { for (const id of tiles.keys()) setHidden(id, true); });
  $('showAllTiles').addEventListener('click', () => { for (const id of tiles.keys()) setHidden(id, false); });

  $('startAllTiles').addEventListener('click', () => { for (const id of tiles.keys()) load(id); });
  $('stopAllTiles').addEventListener('click', () => { for (const id of tiles.keys()) unload(id); });
  ['tileW', 'tileH', 'fixedSize'].forEach((id) => $(id).addEventListener('input', applyLayout));
  window.addEventListener('resize', applyLayout);
  // Escape leaves the zoomed view.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && expandedId) setExpanded(null); });

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
    // Everything live right away — the whole point of the dashboard is seeing
    // them all running at once.
    for (const id of tiles.keys()) load(id);
    setInterval(() => { if (!document.hidden) poll(); }, 1000);
    poll();
  })();
})();
