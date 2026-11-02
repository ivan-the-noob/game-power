/* ===========================================================================
 * Game Power — control panel.
 *
 * One original, and clones made from it. An instance is the game's own
 * Windows client running in its own folder, so the RAM column is the private
 * working set of that client's process tree — what it genuinely costs.
 * ======================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');

  let ORIGINAL_ID = 1;
  let rowsCache = [];
  let cloneWasBusy = false;
  let groupsCache = [];
  let groupFilter = '';
  let gameReady = false;
  let recSources = new Set();
  const recState = new Map();

  function msgEl(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* ---- asking for a line of text ---------------------------------------- */
  let askResolve = null;

  function askText(title, value) {
    return new Promise((resolve) => {
      askResolve = resolve;
      $('askTitle').textContent = title;
      $('askInput').value = value || '';
      $('askModal').classList.remove('hidden');
      $('askInput').focus();
      $('askInput').select();
    });
  }

  function closeAsk(value) {
    $('askModal').classList.add('hidden');
    if (askResolve) { const r = askResolve; askResolve = null; r(value); }
  }

  $('askOk').addEventListener('click', () => closeAsk($('askInput').value));
  $('askCancel').addEventListener('click', () => closeAsk(null));
  $('askInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeAsk($('askInput').value);
    else if (e.key === 'Escape') closeAsk(null);
  });

  /* ---- where is the game? ----------------------------------------------- */
  async function checkGame() {
    const h = await window.api.health().catch(() => null);
    gameReady = !!(h && h.ok);
    $('gamePath').value = (h && h.gamePath) || '';
    $('setupState').textContent = gameReady ? `Ready — ${h.exe}` : ((h && h.error) || 'Not set.');
    $('setupCard').classList.toggle('setup', !gameReady);
    $('installNote').textContent = gameReady
      ? `Install is ${gb(h.installMB)}. Shared by link: ${[...(h.linkDirs || []), ...(h.bigFiles || []).map((f) => f.name)].join(', ') || 'nothing found'}. Instances are built in ${h.clientsRoot}`
      : 'Pick the folder that contains the game\'s .exe.';
    for (const id of ['startOriginalBtn', 'startAllBtn', 'cloneBtn', 'resetOriginalBtn']) $(id).disabled = !gameReady;

    if (h && h.migrated) {
      const bar = $('updateBar');
      bar.classList.remove('hidden');
      $('updateText').textContent = h.migrated;
      $('updateRestart').classList.add('hidden');
    }
    return gameReady;
  }

  $('pickPathBtn').addEventListener('click', async () => {
    const r = await window.api.setPath(null).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { if (r && r.error !== 'Cancelled.') msgEl('cfgMsg', (r && r.error) || 'Could not use that folder.', 'err'); return; }
    msgEl('cfgMsg', `Found ${r.exe} — install is ${gb(r.installMB)}.`, 'ok');
    await checkGame();
    const s = await window.api.getSettings().catch(() => null);
    if (s && s.ok) writeForm(s.settings);
    poll();
  });

  $('openFolderBtn').addEventListener('click', () => window.api.openFolder(ORIGINAL_ID).catch(() => {}));

  /* ---- settings --------------------------------------------------------- */
  function readForm() {
    return {
      width: Number($('cfgW').value) || 800,
      height: Number($('cfgH').value) || 600,
      fpsLimit: Number($('cfgFps').value) || 30,
      glowQuality: Number($('cfgGlow').value) || 0,
      waterQuality: Number($('cfgWater').value) || 0,
      shadowQuality: Number($('cfgShadow').value) || 0,
      antialias: Number($('cfgAA').value) || 0,
      muteAll: $('cfgMute').checked,
      runInBackground: $('cfgBackground').checked,
      fullscreen: $('cfgFullscreen').checked,
      recLoops: Number($('cfgLoops').value) || 0,
      recLoopGapMin: Number($('cfgLoopGapMin').value) || 0,
      recLoopGap: Number($('cfgLoopGap').value) || 0,
      recSpeed: Number($('cfgSpeed').value) || 1,
      recFixedGap: Number($('cfgFixedGap').value) || 0,
    };
  }

  function writeForm(s) {
    $('cfgW').value = s.width;
    $('cfgH').value = s.height;
    $('cfgFps').value = s.fpsLimit;
    $('cfgGlow').value = String(s.glowQuality);
    $('cfgWater').value = String(s.waterQuality);
    $('cfgShadow').value = String(s.shadowQuality);
    $('cfgAA').value = String(s.antialias);
    $('cfgMute').checked = s.muteAll !== false;
    $('cfgBackground').checked = s.runInBackground !== false;
    $('cfgFullscreen').checked = !!s.fullscreen;
    $('cfgLoops').value = s.recLoops != null ? s.recLoops : 0;
    $('cfgLoopGapMin').value = s.recLoopGapMin != null ? s.recLoopGapMin : 0;
    $('cfgLoopGap').value = s.recLoopGap != null ? s.recLoopGap : 1;
    $('cfgSpeed').value = s.recSpeed != null ? s.recSpeed : 1;
    $('cfgFixedGap').value = s.recFixedGap != null ? s.recFixedGap : 0;
  }

  /* ---- the table ---------------------------------------------------------
   * Rebuilt only when the rows change shape, and never while something in the
   * table has focus: a full redraw once a second would close an open group
   * dropdown the moment the mouse moved.
   * ---------------------------------------------------------------------- */
  const ramClass = (mb) => (mb > 1200 ? 'max' : mb > 700 ? 'hot' : '');

  let lastSig = '';
  let rebuildWanted = false;

  const rowSignature = (rows) => rows.map((r) => {
    const rec = recState.get(r.id) || {};
    return [r.id, r.name, r.group || '', r.status, r.hasCred ? 1 : 0, r.built ? 1 : 0,
      rec.recording ? 1 : 0, rec.playing ? 1 : 0, rec.steps || 0].join('|');
  }).join(';') + '::' + groupsCache.join(',') + '::' + [...recSources].sort().join(',');

  function updateInPlace(rows, peak) {
    for (const r of rows) {
      const tr = $('rows').querySelector(`tr[data-id="${r.id}"]`);
      if (!tr || !r.alive) continue;
      const cell = (n) => tr.children[n];
      const num = (n) => cell(n) && cell(n).querySelector('.num');
      const bar = cell(4) && cell(4).querySelector('i');
      if (num(4)) num(4).textContent = r.ramMB;
      if (bar) {
        bar.className = ramClass(r.ramMB);
        bar.style.width = Math.min(100, Math.round((r.ramMB / peak) * 100)) + '%';
      }
      if (num(5)) num(5).textContent = r.cpu.toFixed(1);
      if (num(6)) num(6).textContent = r.upMin;
    }
  }

  $('rows').addEventListener('focusout', () => {
    if (rebuildWanted) { rebuildWanted = false; lastSig = ''; poll(); }
  });

  function statusPill(r) {
    if (r.status === 'running') return '<span class="pill on">Running</span>';
    if (r.status === 'starting') return '<span class="pill warn">Starting…</span>';
    if (r.status === 'error') return `<span class="pill bad" title="${esc(r.note || '')}">Closed</span>`;
    return `<span class="pill off">${r.built ? 'Stopped' : 'Not built'}</span>`;
  }

  function renderRows(m) {
    rowsCache = m.rows;
    const body = $('rows');
    const shown = groupFilter ? m.rows.filter((r) => (r.group || '') === groupFilter) : m.rows;
    if (!shown.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">Nothing in "${esc(groupFilter)}" yet.</td></tr>`;
      lastSig = '';
      return;
    }
    const peak = Math.max(600, ...shown.map((r) => r.ramMB));
    const sig = rowSignature(shown);
    if (sig === lastSig) { updateInPlace(shown, peak); return; }
    if (body.contains(document.activeElement)) { rebuildWanted = true; updateInPlace(shown, peak); return; }
    lastSig = sig;

    body.innerHTML = shown.map((r) => {
      const ram = r.alive
        ? `<span class="num">${r.ramMB}</span> MB<div class="bar"><i class="${ramClass(r.ramMB)}" style="width:${Math.min(100, Math.round((r.ramMB / peak) * 100))}%"></i></div>`
        : '<span class="num dim">—</span>';
      const cpu = r.alive ? `<span class="num">${r.cpu.toFixed(1)}</span>%` : '<span class="num dim">—</span>';
      const up = r.alive ? `<span class="num">${r.upMin}</span>m` : '<span class="dim">—</span>';
      const tag = r.original
        ? '<span class="tag orig">original</span>'
        : (r.from ? `<span class="tag" title="Cloned from instance #${r.from}">from #${r.from}</span>` : '');
      const rec = recState.get(r.id) || {};
      const running = r.status === 'running' || r.status === 'starting';
      const borrow = !rec.steps && recSources.has(ORIGINAL_ID) && r.id !== ORIGINAL_ID;
      const canPlay = running && (rec.steps > 0 || borrow);
      const playTitle = borrow ? "Run the original's recording on this instance" : "Replay this instance's recording on a loop";

      const acts = r.alive
        ? `${rec.recording
            ? `<button class="tiny danger-on" data-act="stopRecord" data-id="${r.id}">■ Stop rec</button>`
            : `<button class="tiny" data-act="record" data-id="${r.id}" title="Record every click you make on this instance"${running ? '' : ' disabled'}>● Rec</button>`}
           ${rec.playing
            ? `<button class="tiny go-on" data-act="stopPlay" data-id="${r.id}">⏹ Stop</button>`
            : `<button class="tiny${borrow ? ' borrowed' : ''}" data-act="play" data-id="${r.id}" title="${esc(playTitle)}"${canPlay ? '' : ' disabled'}>▶ Play</button>`}
           <span class="steps" title="Clicks recorded on this instance">${rec.steps || 0}</span>
           <button class="tiny" data-act="reload" data-id="${r.id}" title="Close and start it again">Restart</button>
           <button class="tiny" data-act="stop" data-id="${r.id}">Stop</button>`
        : `<button class="tiny" data-act="start" data-id="${r.id}"${gameReady ? '' : ' disabled'}>Start</button>
           <button class="tiny" data-act="cloneThis" data-id="${r.id}" title="Make a new instance from this one">Clone</button>
           ${r.original ? '' : `<button class="tiny" data-act="remove" data-id="${r.id}" title="Delete this instance's own folder. The game install is untouched.">Delete</button>`}`;

      const opts = ['', ...groupsCache].map((g) =>
        `<option value="${esc(g)}"${(r.group || '') === g ? ' selected' : ''}>${g ? esc(g) : '— none —'}</option>`).join('');
      const details = `<button class="tiny${r.hasCred ? ' has-cred' : ''}" data-act="cred" data-id="${r.id}" title="Saved details for this account">🔑 Details</button>`;

      return `<tr data-id="${r.id}">
        <td class="idx num">#${r.id}</td>
        <td class="name" data-act="rename" data-id="${r.id}" title="Double-click to rename">${esc(r.name)}${tag}</td>
        <td><select class="row-group" data-id="${r.id}">${opts}</select></td>
        <td>${statusPill(r)}</td>
        <td>${ram}</td>
        <td>${cpu}</td>
        <td>${up}</td>
        <td class="acts">${details}${acts}</td>
      </tr>`;
    }).join('');
  }

  function renderStats(m) {
    $('stRunning').textContent = m.running;
    $('stRunningSub').textContent = `of ${m.count} instance${m.count === 1 ? '' : 's'}`;
    $('stInst').textContent = m.instancesMB;
    $('stEach').textContent = m.perInstanceMB;
    $('stRamFree').textContent = (m.hostFreeMB / 1024).toFixed(1);
    $('stRamSub').textContent = `GB of ${(m.hostTotalMB / 1024).toFixed(0)}`;

    const failed = m.rows.filter((r) => r.status === 'error').length;
    $('monitorNote').textContent = failed
      ? `${m.running} running · ${failed} closed unexpectedly`
      : (m.running ? `${m.running} running` : 'Nothing running.');
    $('stopAllBtn').disabled = m.running === 0;

    const orig = m.rows.find((r) => r.original);
    $('originNote').textContent = orig
      ? (orig.status === 'running' ? `Running · ${orig.ramMB} MB`
        : orig.status === 'starting' ? 'Starting…'
          : orig.status === 'error' ? (orig.note || 'Closed') : (orig.built ? 'Stopped' : 'Not built yet'))
      : '—';
    $('startOriginalBtn').textContent = orig && orig.alive ? '▶ Running' : '▶ Start the original';
    $('startOriginalBtn').disabled = !gameReady || !!(orig && orig.alive);

    const want = m.rows.map((r) => `${r.id}|${r.name}`).join(',');
    const sel = $('cloneFrom');
    if (sel.dataset.sig !== want) {
      sel.dataset.sig = want;
      const keep = Number(sel.value) || ORIGINAL_ID;
      sel.innerHTML = m.rows.map((r) => `<option value="${r.id}">#${r.id} ${esc(r.name)}</option>`).join('');
      sel.value = m.rows.some((r) => r.id === keep) ? String(keep) : String(ORIGINAL_ID);
    }
  }

  /* ---- groups ----------------------------------------------------------- */
  function renderGroupBar() {
    const counts = new Map();
    for (const r of rowsCache) {
      const g = r.group || '';
      if (g) counts.set(g, (counts.get(g) || 0) + 1);
    }
    const chip = (g, label, n) =>
      `<button class="group-chip${groupFilter === g ? ' active' : ''}" data-group="${esc(g)}">${esc(label)}${n != null ? ` <span class="chip-n">${n}</span>` : ''}</button>`;
    $('groupBar').innerHTML =
      chip('', 'All', rowsCache.length)
      + groupsCache.map((g) => chip(g, g, counts.get(g) || 0)).join('')
      + '<button class="group-new" id="newGroupBtn">+ Create group</button>'
      + (groupFilter ? `<button class="group-del" id="delGroupBtn">Delete "${esc(groupFilter)}"</button>` : '');
  }

  async function loadGroups() {
    const r = await window.api.groupList().catch(() => null);
    groupsCache = (r && r.ok) ? r.groups : [];
    if (groupFilter && !groupsCache.includes(groupFilter)) groupFilter = '';
    renderGroupBar();
  }

  $('groupBar').addEventListener('click', async (e) => {
    const chip = e.target.closest('.group-chip');
    if (chip) { groupFilter = chip.dataset.group || ''; renderGroupBar(); poll(); return; }
    if (e.target.closest('#newGroupBtn')) {
      const name = await askText('Name for the new group', '');
      if (name == null) return;
      const r = await window.api.groupCreate(name).catch((err) => ({ ok: false, error: err.message }));
      if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Could not create it.', 'err'); return; }
      await loadGroups();
      poll();
      return;
    }
    if (e.target.closest('#delGroupBtn')) {
      if (!confirm(`Delete the group "${groupFilter}"?\n\nThe instances in it are kept.`)) return;
      await window.api.groupDelete(groupFilter).catch(() => {});
      groupFilter = '';
      await loadGroups();
      poll();
    }
  });

  $('rows').addEventListener('change', async (e) => {
    const sel = e.target.closest('select.row-group');
    if (!sel) return;
    await window.api.groupSet([Number(sel.dataset.id)], sel.value).catch(() => {});
    await loadGroups();
    poll();
  });

  /* ---- saved details ---------------------------------------------------- */
  let credForId = null;
  const setCredVisible = (on) => {
    $('credPass').type = on ? 'text' : 'password';
    $('credPin').type = on ? 'text' : 'password';
  };

  async function openCred(id) {
    credForId = Number(id);
    const row = rowsCache.find((r) => r.id === credForId);
    $('credTitle').textContent = `Details · #${credForId} ${row ? row.name : ''}`;
    const r = await window.api.credGet(credForId).catch(() => null);
    const c = (r && r.ok) ? r.cred : {};
    $('credUser').value = c.user || '';
    $('credPass').value = c.pass || '';
    $('credPin').value = c.pin || '';
    $('credExtra').value = c.extra || '';
    $('credNote').value = c.note || '';
    $('credShow').checked = false;
    setCredVisible(false);
    msgEl('credMsg', '');
    $('credModal').classList.remove('hidden');
    $('credUser').focus();
  }

  $('credShow').addEventListener('change', () => setCredVisible($('credShow').checked));
  $('credClose').addEventListener('click', () => $('credModal').classList.add('hidden'));
  $('credSave').addEventListener('click', async () => {
    if (!credForId) return;
    const r = await window.api.credSet(credForId, {
      user: $('credUser').value,
      pass: $('credPass').value,
      pin: $('credPin').value,
      extra: $('credExtra').value,
      note: $('credNote').value,
    }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('credMsg', (r && r.error) || 'Could not save.', 'err'); return; }
    msgEl('credMsg', 'Saved.', 'ok');
    poll();
    setTimeout(() => $('credModal').classList.add('hidden'), 700);
  });

  /* ---- updates ---------------------------------------------------------- */
  async function loadUpdateCfg() {
    const r = await window.api.updateStatus().catch(() => null);
    if (!r || !r.ok || !r.cfg) return;
    $('updRepo').value = r.cfg.repo || '';
    $('updBranch').value = r.cfg.branch || 'main';
    $('updToken').value = r.cfg.token || '';
    $('updEnabled').checked = r.cfg.enabled !== false;
    const last = r.last;
    $('updStatus').textContent = !last ? 'Not checked yet.'
      : last.error ? last.error
        : last.ok
          ? (last.updated && last.updated.length ? `Updated ${last.updated.length} file(s) — restart to apply.` : 'Up to date.')
          : 'Last check failed.';
  }

  $('updSaveBtn').addEventListener('click', async () => {
    const btn = $('updSaveBtn');
    btn.disabled = true;
    msgEl('updMsg', 'Saving…', '');
    await window.api.updateSaveConfig({
      repo: $('updRepo').value.trim(),
      branch: $('updBranch').value.trim(),
      token: $('updToken').value.trim(),
      enabled: $('updEnabled').checked,
    }).catch(() => {});
    const r = await window.api.checkUpdate().catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (!r || !r.ok) { msgEl('updMsg', (r && r.error) || 'Check failed.', 'err'); return; }
    if (r.error) { msgEl('updMsg', r.error, 'err'); loadUpdateCfg(); return; }
    const n = (r.updated || []).length;
    msgEl('updMsg', n ? `Pulled ${n} file${n === 1 ? '' : 's'} — restart to run them.` : 'Already up to date.', 'ok');
    showUpdate(r);
    loadUpdateCfg();
  });

  /* ---- cloning ---------------------------------------------------------- */
  function renderClone(c) {
    if (!c) return;
    const wrap = $('cloneBarWrap');
    if (c.busy) {
      wrap.classList.remove('hidden');
      $('cloneBar').style.width = c.done + '%';
      $('cloneBtn').disabled = true;
      msgEl('cloneMsg', `Building #${c.newId} ${c.name}…`, '');
      cloneWasBusy = true;
      return;
    }
    if (cloneWasBusy) {
      cloneWasBusy = false;
      wrap.classList.add('hidden');
      $('cloneBtn').disabled = false;
      if (c.error) msgEl('cloneMsg', c.error, 'err');
      else msgEl('cloneMsg', 'Done. Start the clone and log it into its own account.', 'ok');
      refreshDisk();
    }
  }

  async function refreshDisk() {
    const d = await window.api.disk().catch(() => null);
    if (!d || !d.ok) return;
    $('stDiskUsed').textContent = d.totalMB;
    $('diskNote').textContent = `${gb(d.totalMB)} across ${d.rows.length} instance${d.rows.length === 1 ? '' : 's'} · ${gb(d.freeMB)} free · game data is shared, not copied`;
  }

  async function refreshRecSources() {
    const r = await window.api.recSources().catch(() => null);
    const next = new Set(((r && r.ok ? r.ids : []) || []).map(Number));
    if (next.size !== recSources.size || [...next].some((id) => !recSources.has(id))) {
      recSources = next;
      lastSig = '';
    }
  }

  async function poll() {
    const m = await window.api.metrics().catch(() => null);
    if (!m || !m.ok) return;
    renderStats(m);
    renderRows(m);
    renderClone(m.clone);
  }

  /* ---- actions ---------------------------------------------------------- */
  async function doClone(from, count) {
    const src = rowsCache.find((r) => r.id === Number(from));
    const label = src ? `#${src.id} ${src.name}` : `#${from}`;
    const n = Math.max(1, Math.min(50, parseInt(count, 10) || 1));
    if (!confirm(`Create ${n} clone${n === 1 ? '' : 's'} of ${label}?\n\n${label} is closed first, so its settings are written out before they are copied.`)) return;
    $('cloneBtn').disabled = true;
    cloneWasBusy = true;
    $('cloneBarWrap').classList.remove('hidden');
    const r = await window.api.clone(from, n).catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) {
      cloneWasBusy = false;
      $('cloneBarWrap').classList.add('hidden');
      $('cloneBtn').disabled = false;
      msgEl('cloneMsg', r.error || 'Clone failed.', 'err');
    }
    poll();
  }

  $('cloneBtn').addEventListener('click', () => doClone($('cloneFrom').value, $('cloneCount').value));

  $('rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;
    if (act === 'cloneThis') { doClone(id, $('cloneCount').value); return; }
    if (act === 'cred') { openCred(id); return; }

    if (['record', 'stopRecord', 'play', 'stopPlay'].includes(act)) {
      const cmd = act === 'stopPlay' ? 'stop' : act;
      const rec = recState.get(id) || {};
      const opts = (cmd === 'play' && !rec.steps && recSources.has(ORIGINAL_ID) && id !== ORIGINAL_ID)
        ? { from: ORIGINAL_ID } : undefined;
      const res = await window.api.clickCmd(id, cmd, opts).catch((err) => ({ ok: false, error: err.message }));
      if (res && !res.ok) { msgEl('cfgMsg', res.error, 'err'); return; }
      refreshRecSources();
      return;
    }

    if (act === 'remove') {
      const row = rowsCache.find((r) => r.id === id);
      if (!confirm(`Delete #${id} ${row ? row.name : ''}?\n\nOnly this instance's own folder goes. The game install is untouched.`)) return;
    }
    btn.disabled = true;
    const r = await window.api[act](id).catch((err) => ({ ok: false, error: err.message }));
    if (r && !r.ok) msgEl('cfgMsg', r.error || 'That did not work.', 'err');
    poll();
    if (act === 'remove') refreshDisk();
  });

  if (window.api.onClickState) {
    window.api.onClickState((s) => {
      if (!s || !s.id) return;
      recState.set(Number(s.id), { steps: s.steps || 0, recording: !!s.recording, playing: !!s.playing });
      poll();
    });
  }

  $('rows').addEventListener('dblclick', async (e) => {
    const cell = e.target.closest('td.name[data-id]');
    if (!cell) return;
    const id = Number(cell.dataset.id);
    const row = rowsCache.find((r) => r.id === id);
    const name = await askText(`Name for instance #${id}`, row ? row.name : '');
    if (name == null) return;
    await window.api.rename(id, name).catch(() => {});
    poll();
  });

  $('startOriginalBtn').addEventListener('click', async () => {
    const r = await window.api.start(ORIGINAL_ID).catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) { msgEl('cfgMsg', r.error, 'err'); return; }
    msgEl('cfgMsg', 'Starting the client. If it closes itself straight away, the row will say so.', 'ok');
    poll();
    setTimeout(poll, 7000);
  });

  $('resetOriginalBtn').addEventListener('click', async () => {
    if (!confirm('Reset the original?\n\nIts own folder is rebuilt from the install, so its settings and local files go. The game install itself is untouched.')) return;
    const r = await window.api.reset(ORIGINAL_ID).catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) msgEl('cfgMsg', r.error, 'err');
    poll();
    refreshDisk();
  });

  $('startAllBtn').addEventListener('click', async () => {
    const btn = $('startAllBtn');
    btn.disabled = true;
    const r = await window.api.startAll().catch(() => null);
    btn.disabled = false;
    if (r && r.ok) msgEl('cfgMsg', r.opened ? `Started ${r.opened}.` : 'Everything is already running.', 'ok');
    poll();
    setTimeout(poll, 7000);
  });

  $('stopAllBtn').addEventListener('click', async () => {
    await window.api.stopAll().catch(() => {});
    poll();
  });

  $('stageBtn').addEventListener('click', async () => {
    const r = await window.api.openStage().catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) msgEl('cfgMsg', r.error, 'err');
  });

  $('applyBtn').addEventListener('click', async () => {
    const r = await window.api.apply(readForm()).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Could not save.', 'err'); return; }
    msgEl('cfgMsg', r.note || 'Saved.', 'ok');
  });

  /* ---- code updates ---------------------------------------------------- */
  function showUpdate(r) {
    if (!r || !r.ok) return;
    if (!r.updated || !r.updated.length) return;
    const bar = $('updateBar');
    bar.classList.remove('hidden', 'err');
    $('updateRestart').classList.remove('hidden');
    $('updateRestart').disabled = false;
    $('updateRestart').textContent = 'Restart now';
    const n = r.updated.length;
    $('updateText').textContent = `Updated ${n} file${n === 1 ? '' : 's'} from GitHub — restart to run the new code.`;
  }

  if (window.api.onUpdateResult) window.api.onUpdateResult(showUpdate);
  $('updateDismiss').addEventListener('click', () => $('updateBar').classList.add('hidden'));

  // Awaited, because a portable build cannot always relaunch itself and
  // clicking Restart and seeing nothing happen is the worst outcome.
  $('updateRestart').addEventListener('click', async () => {
    const btn = $('updateRestart');
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    const r = await window.api.restart().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      btn.disabled = false;
      btn.textContent = 'Restart now';
      $('updateText').textContent = (r && r.error) || 'Could not restart automatically — close Game Power and open it again.';
      $('updateBar').classList.add('err');
      return;
    }
    $('updateText').textContent = r.note || 'Restarting…';
  });

  $('checkUpdateBtn').addEventListener('click', async () => {
    const btn = $('checkUpdateBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const r = await window.api.checkUpdate().catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    btn.textContent = 'Check for updates';
    if (r && r.error) { msgEl('cfgMsg', r.error, 'err'); return; }
    if (r && r.ok && (!r.updated || !r.updated.length)) msgEl('cfgMsg', 'Already running the newest code.', 'ok');
    showUpdate(r);
  });

  /* ---- go --------------------------------------------------------------- */
  (async function start() {
    const s = await window.api.getSettings().catch(() => null);
    if (s && s.ok) { ORIGINAL_ID = s.originalId || 1; writeForm(s.settings); }
    const v = await window.api.version().catch(() => null);
    if (v && v.ok) $('footVersion').textContent = `v${v.version} · Electron ${String(v.electron).split('.')[0]}`;
    await checkGame();
    await loadGroups();
    await refreshRecSources();
    await poll();
    renderGroupBar();
    refreshDisk();
    loadUpdateCfg();
    setInterval(() => { if (!document.hidden) poll(); }, 1000);
    setInterval(() => { if (!document.hidden) refreshRecSources(); }, 5000);
  })();
})();
