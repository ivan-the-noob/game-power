/* ===========================================================================
 * Game Power — the dashboard.
 *
 * Every instance in one window, with its live memory, CPU and recorder state,
 * and the controls that matter: start, stop, record, play.
 *
 * What it does NOT yet do is show the game itself. Under the browser engine a
 * tile was a <webview>; under Android it was a stream of frames pulled over
 * ADB. Neither applies to a native Windows client — showing those needs the
 * game's own windows captured and matched to instances, and that cannot be
 * built honestly until the client is confirmed to run more than one copy and
 * we know how it titles its windows. Until then this reports what is true
 * rather than showing an empty frame.
 * ======================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let cfg = null;
  const cards = new Map();   // id -> { row, el, statEl, noteEl, rec, status }

  function build(row) {
    const el = document.createElement('div');
    el.className = 'tile card-tile';
    el.dataset.id = row.id;
    el.innerHTML = `
      <div class="tile-head">
        <span class="tile-id">#${row.id}</span>
        <span class="tile-name">${esc(row.name)}${row.original ? ' ★' : ''}</span>
        <span class="tile-stat" data-stat>stopped</span>
      </div>
      <div class="card-body">
        <div class="card-note" data-note>Not running.</div>
        <div class="card-btns">
          <button data-act="start" class="primary tiny">▶ Start</button>
          <button data-act="stop" class="tiny">■ Stop</button>
          <button data-act="restart" class="tiny">↻ Restart</button>
          <button data-act="record" class="tiny">● Rec</button>
          <button data-act="play" class="tiny">▶ Play</button>
          <span class="steps" data-steps title="Clicks recorded">0</span>
        </div>
      </div>`;
    const card = {
      row,
      el,
      statEl: el.querySelector('[data-stat]'),
      noteEl: el.querySelector('[data-note]'),
      stepsEl: el.querySelector('[data-steps]'),
      rec: {},
      status: 'stopped',
    };
    cards.set(row.id, card);
    return el;
  }

  function words(m) {
    if (!m) return 'stopped';
    if (m.status === 'starting') return 'starting…';
    if (m.status === 'running') return 'running';
    if (m.status === 'error') return 'closed';
    return m.built ? 'stopped' : 'not built';
  }

  async function poll() {
    const r = await window.stage.metrics().catch(() => null);
    if (!r || !r.ok) return;
    const byId = new Map(r.rows.map((x) => [Number(x.id), x]));
    let running = 0;
    let totalMB = 0;

    for (const c of cards.values()) {
      const m = byId.get(Number(c.row.id));
      c.status = m ? m.status : 'stopped';
      if (m && m.alive) { running += 1; totalMB += m.ramMB; }

      c.el.classList.toggle('live', c.status === 'running');
      c.el.classList.toggle('offline', c.status === 'error');

      const label = words(m);
      c.statEl.textContent = m && m.alive ? `${m.ramMB} MB · ${m.cpu}% · ${label}` : label;
      c.statEl.className = 'tile-stat' + (m && m.ramMB > 1200 ? ' max' : m && m.ramMB > 700 ? ' hot' : '');
      c.noteEl.textContent = (m && m.note) || (m && m.alive
        ? `Up ${m.upMin} min. Its window is on your desktop.`
        : (m && m.built ? 'Not running.' : 'Not built yet — start it once to build it.'));
    }

    const freeGB = (r.hostFreeMB / 1024).toFixed(1);
    $('stageSum').textContent = running
      ? `${running} of ${cards.size} running · ${totalMB} MB total · ${freeGB} GB RAM free`
      : `${cards.size} instance${cards.size === 1 ? '' : 's'} · none running · ${freeGB} GB RAM free`;
  }

  /* ---- the recorder ----------------------------------------------------- */
  const send = (id, cmd, opts) => window.stage.clickCmd(id, cmd, opts).catch(() => null);

  function paintRec(id) {
    const c = cards.get(Number(id));
    if (!c) return;
    const r = c.rec || {};
    const recBtn = c.el.querySelector('button[data-act="record"]');
    const playBtn = c.el.querySelector('button[data-act="play"]');
    if (recBtn) { recBtn.textContent = r.recording ? '■ Stop rec' : '● Rec'; recBtn.style.color = r.recording ? 'var(--red)' : ''; }
    if (playBtn) { playBtn.textContent = r.playing ? '⏹ Stop' : '▶ Play'; playBtn.style.color = r.playing ? 'var(--green)' : ''; }
    if (c.stepsEl) c.stepsEl.textContent = r.steps || 0;
    c.el.classList.toggle('recording', !!r.recording);
  }

  window.stage.onClickState((s) => {
    const c = cards.get(Number(s && s.id));
    if (!c) return;
    c.rec = s || {};
    paintRec(c.row.id);
  });

  /* ---- events ----------------------------------------------------------- */
  $('grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('.tile').dataset.id);
    const c = cards.get(id);
    const act = btn.dataset.act;
    if (act === 'start') { c.noteEl.textContent = 'starting…'; await window.stage.start(id).catch(() => {}); }
    else if (act === 'stop') await window.stage.stop(id).catch(() => {});
    else if (act === 'restart') await window.stage.restart(id).catch(() => {});
    else if (act === 'record') send(id, (c.rec && c.rec.recording) ? 'stopRecord' : 'record');
    else if (act === 'play') send(id, (c.rec && c.rec.playing) ? 'stop' : 'play');
    poll();
  });

  $('startAllTiles').addEventListener('click', async () => {
    // One at a time: several clients starting together fight over the same
    // disk and the same GPU, and all of them take longer than they need to.
    for (const id of cards.keys()) {
      await window.stage.start(id).catch(() => null);
      await sleep(2000);
    }
    poll();
  });

  $('stopAllTiles').addEventListener('click', async () => {
    for (const id of cards.keys()) await window.stage.stop(id).catch(() => null);
    poll();
  });

  $('playAllBtn').addEventListener('click', async () => {
    const src = Number($('recFrom').value) || null;
    let n = 0;
    for (const c of cards.values()) {
      if (c.status !== 'running') continue;
      const opts = src && src !== c.row.id ? { from: src } : undefined;
      const r = await send(c.row.id, 'play', opts);
      if (r && r.ok) n += 1;
    }
    if (!n) alert('No instance is running, or nothing is recorded yet.');
  });

  $('stopAllRecBtn').addEventListener('click', () => { for (const id of cards.keys()) send(id, 'stop'); });

  async function refreshRecSources() {
    const r = await window.stage.recSources().catch(() => null);
    const ids = (r && r.ok ? r.ids : []) || [];
    const sel = $('recFrom');
    const keep = sel.value;
    sel.innerHTML = '<option value="">each its own</option>'
      + ids.map((id) => {
        const c = cards.get(Number(id));
        return `<option value="${id}">#${id} ${esc(c ? c.row.name : '')}</option>`;
      }).join('');
    if (keep && ids.includes(Number(keep))) sel.value = keep;
  }

  $('groupSel').addEventListener('change', () => {
    const want = $('groupSel').value || '';
    for (const c of cards.values()) {
      c.el.style.display = (!want || (c.row.group || '') === want) ? '' : 'none';
    }
  });

  /* ---- go --------------------------------------------------------------- */
  (async function start() {
    cfg = await window.stage.data().catch(() => null);
    const grid = $('grid');
    if (!cfg || !cfg.ok || !cfg.rows.length) {
      grid.innerHTML = '<div class="stage-empty">No instances yet. Create them in the control panel first.</div>';
      return;
    }
    $('groupSel').innerHTML = '<option value="">All</option>'
      + (cfg.groups || []).map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');

    grid.innerHTML = '';
    for (const row of cfg.rows) grid.appendChild(build(row));

    for (const id of cards.keys()) {
      send(id, 'state').then((r) => {
        if (r && r.ok && r.state) { cards.get(id).rec = r.state; paintRec(id); }
      });
    }

    await poll();
    setInterval(() => { if (!document.hidden) poll(); }, 1500);
    setInterval(refreshRecSources, 10000);
    refreshRecSources();
  })();
})();
