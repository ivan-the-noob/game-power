/* ===========================================================================
 * Game Power — control panel.
 *
 * One original, and clones made from it. An instance is a real Android guest,
 * so the RAM column is the private working set of that guest's whole process
 * tree — what it genuinely costs, not the shared system image it maps.
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
  let groupFilter = '';          // '' = All
  let androidReady = false;
  let recSources = new Set();    // instances that have something recorded
  // id -> { steps, recording, playing } as reported by the recorder
  const recState = new Map();

  function msgEl(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  /* ---- asking for a line of text -----------------------------------------
   * Electron does not implement window.prompt — it returns nothing and shows
   * nothing — so every "name this" box has to be a real one.
   * ---------------------------------------------------------------------- */
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

  /* ---- is Android installed? ---------------------------------------------
   * Without the emulator and a system image there is nothing to run, so this
   * card is the first thing shown and everything else stays disabled.
   * ---------------------------------------------------------------------- */
  async function checkAndroid() {
    const h = await window.api.androidHealth().catch(() => null);
    androidReady = !!(h && h.ok);
    $('setupCard').classList.toggle('hidden', androidReady);
    if (h) $('setupState').textContent = androidReady ? 'Ready.' : `Missing: ${h.missing.join(', ')}`;
    for (const id of ['startOriginalBtn', 'startAllBtn', 'cloneBtn', 'openSiteBtn', 'installApkBtn', 'pickAppBtn']) {
      $(id).disabled = !androidReady;
    }
    // Said once, on the first launch after the switch from the browser engine.
    if (h && h.migrated) {
      const bar = $('updateBar');
      bar.classList.remove('hidden');
      $('updateText').textContent = h.migrated;
      $('updateRestart').classList.add('hidden');
    }
    return androidReady;
  }

  $('setupBtn').addEventListener('click', async () => {
    const btn = $('setupBtn');
    btn.disabled = true;
    $('setupLog').classList.remove('hidden');
    $('setupLog').textContent = '';
    msgEl('setupMsg', 'Downloading — this is a few GB, so give it time.', '');
    const r = await window.api.androidInstall().catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (!r || !r.ok) { msgEl('setupMsg', (r && r.error) || 'Setup failed.', 'err'); return; }
    msgEl('setupMsg', 'Android is ready.', 'ok');
    checkAndroid();
  });

  if (window.api.onAndroidLog) {
    window.api.onAndroidLog((line) => {
      const el = $('setupLog');
      el.classList.remove('hidden');
      // Keep the tail only: sdkmanager prints a progress line per percent.
      el.textContent = (el.textContent + line + '\n').split('\n').slice(-12).join('\n');
      el.scrollTop = el.scrollHeight;
    });
  }

  /* ---- settings --------------------------------------------------------- */
  function readForm() {
    return {
      url: $('cfgUrl').value.trim(),
      ram: Number($('cfgRam').value) || 1024,
      cores: Number($('cfgCores').value) || 1,
      gpu: $('cfgGpu').value,
      width: Number($('cfgW').value) || 800,
      height: Number($('cfgH').value) || 480,
      dpi: Number($('cfgDpi').value) || 160,
      diskMB: Number($('cfgDisk').value) || 4096,
      headless: $('cfgHeadless').checked,
      trim: $('cfgTrim').checked,
      kiosk: $('cfgKiosk').checked,
      tileFps: Number($('cfgTileFps').value) || 1,
      zoomFps: Number($('cfgZoomFps').value) || 5,
      recLoops: Number($('cfgLoops').value) || 0,
      recLoopGapMin: Number($('cfgLoopGapMin').value) || 0,
      recLoopGap: Number($('cfgLoopGap').value) || 0,
      recSpeed: Number($('cfgSpeed').value) || 1,
      recFixedGap: Number($('cfgFixedGap').value) || 0,
    };
  }

  function writeForm(s) {
    $('cfgUrl').value = s.url || '';
    $('cfgRam').value = s.ram;
    $('cfgCores').value = s.cores;
    $('cfgGpu').value = s.gpu;
    $('cfgW').value = s.width;
    $('cfgH').value = s.height;
    $('cfgDpi').value = s.dpi;
    $('cfgDisk').value = s.diskMB;
    $('cfgHeadless').checked = s.headless !== false;
    $('cfgTrim').checked = s.trim !== false;
    $('cfgKiosk').checked = s.kiosk !== false;
    $('cfgTileFps').value = s.tileFps != null ? s.tileFps : 1;
    $('cfgZoomFps').value = s.zoomFps != null ? s.zoomFps : 5;
    $('cfgLoops').value = s.recLoops != null ? s.recLoops : 0;
    $('cfgLoopGapMin').value = s.recLoopGapMin != null ? s.recLoopGapMin : 0;
    $('cfgLoopGap').value = s.recLoopGap != null ? s.recLoopGap : 1;
    $('cfgSpeed').value = s.recSpeed != null ? s.recSpeed : 1;
    $('cfgFixedGap').value = s.recFixedGap != null ? s.recFixedGap : 0;
  }

  /* ---- the table ----------------------------------------------------------
   * This redraws once a second, and rebuilding the rows wholesale would throw
   * away whatever you were in the middle of — an open group dropdown closed
   * itself the moment the mouse moved. So the rebuild only happens when the
   * rows actually change shape; the rest of the time RAM, CPU and uptime are
   * written straight into the cells that already exist. And a rebuild never
   * runs while something in the table has focus: it waits until you are done.
   * ------------------------------------------------------------------------ */
  // A guest is sized in gigabytes, so the thresholds sit far above a browser's.
  const ramClass = (mb) => (mb > 1400 ? 'max' : mb > 900 ? 'hot' : '');

  let lastSig = '';
  let rebuildWanted = false;

  const rowSignature = (rows) => rows.map((r) => {
    const rec = recState.get(r.id) || {};
    return [r.id, r.name, r.group || '', r.status, r.hasCred ? 1 : 0, r.pkg || '',
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

  // Once you stop interacting with the table, catch up on anything deferred.
  $('rows').addEventListener('focusout', () => {
    if (rebuildWanted) { rebuildWanted = false; lastSig = ''; poll(); }
  });

  function statusPill(r) {
    if (r.status === 'ready') return '<span class="pill on">Ready</span>';
    if (r.status === 'booting') return '<span class="pill warn" title="Android is starting. A cold boot takes around a minute.">Booting…</span>';
    if (r.status === 'error') return `<span class="pill bad" title="${esc(r.note || '')}">Failed</span>`;
    return '<span class="pill off">Stopped</span>';
  }

  function renderRows(m) {
    rowsCache = m.rows;
    const body = $('rows');
    const shown = groupFilter ? m.rows.filter((r) => (r.group || '') === groupFilter) : m.rows;
    if (!shown.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">Nothing in "${esc(groupFilter)}" yet. Pick a group on a row to move it here.</td></tr>`;
      lastSig = '';
      return;
    }
    const peak = Math.max(1200, ...shown.map((r) => r.ramMB));
    const sig = rowSignature(shown);
    if (sig === lastSig) { updateInPlace(shown, peak); return; }
    // Something structural changed — but never yank a control out from under
    // the mouse. Hold the rebuild until focus leaves the table.
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
      const ready = r.status === 'ready';

      // Play is offered even with nothing recorded here, as long as the
      // original has a recording: that is the whole point of recording once.
      const borrow = !rec.steps && recSources.has(ORIGINAL_ID) && r.id !== ORIGINAL_ID;
      const canPlay = ready && (rec.steps > 0 || borrow);
      const playTitle = borrow ? "Run the original's recording on this instance" : "Replay this instance's recording on a loop";

      const acts = r.alive
        ? `${rec.recording
            ? `<button class="tiny danger-on" data-act="stopRecord" data-id="${r.id}" title="Stop recording">■ Stop rec</button>`
            : `<button class="tiny" data-act="record" data-id="${r.id}" title="Record every tap made on this instance, until you stop"${ready ? '' : ' disabled'}>● Rec</button>`}
           ${rec.playing
            ? `<button class="tiny go-on" data-act="stopPlay" data-id="${r.id}" title="Stop playback">⏹ Stop</button>`
            : `<button class="tiny${borrow ? ' borrowed' : ''}" data-act="play" data-id="${r.id}" title="${esc(playTitle)}"${canPlay ? '' : ' disabled'}>▶ Play</button>`}
           <span class="steps" title="Taps recorded on this instance">${rec.steps || 0}</span>
           <button class="tiny" data-act="reload" data-id="${r.id}" title="Force-stop the game and start it again"${ready ? '' : ' disabled'}>Restart app</button>
           <button class="tiny" data-act="stop" data-id="${r.id}">Stop</button>`
        : `<button class="tiny" data-act="start" data-id="${r.id}"${androidReady ? '' : ' disabled'}>Start</button>
           <button class="tiny" data-act="cloneThis" data-id="${r.id}" title="Make a new instance that is a copy of this one">Clone</button>
           ${r.original ? '' : `<button class="tiny" data-act="remove" data-id="${r.id}" title="Delete this clone and its data">Delete</button>`}`;

      const opts = ['', ...groupsCache].map((g) =>
        `<option value="${esc(g)}"${(r.group || '') === g ? ' selected' : ''}>${g ? esc(g) : '— none —'}</option>`).join('');
      const details = `<button class="tiny${r.hasCred ? ' has-cred' : ''}" data-act="cred" data-id="${r.id}" title="${r.hasCred ? 'Saved details for this account' : 'Save the login details for this account'}">🔑 Details</button>`;

      return `<tr data-id="${r.id}">
        <td class="idx num">#${r.id}</td>
        <td class="name" data-act="rename" data-id="${r.id}" title="Double-click to rename">${esc(r.name)}${tag}</td>
        <td><select class="row-group" data-id="${r.id}" title="Move this instance to a group">${opts}</select></td>
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

    const booting = m.rows.filter((r) => r.status === 'booting').length;
    $('monitorNote').textContent = booting
      ? `${booting} booting · ${m.running} running`
      : (m.running ? `${m.running} running` : 'Nothing running.');
    $('stopAllBtn').disabled = m.running === 0;

    const orig = m.rows.find((r) => r.original);
    $('originNote').textContent = orig
      ? (orig.status === 'ready' ? `Ready · ${orig.ramMB} MB`
        : orig.status === 'booting' ? 'Booting…'
          : orig.status === 'error' ? (orig.note || 'Failed') : 'Stopped')
      : '—';
    $('startOriginalBtn').textContent = orig && orig.alive ? '▶ Running' : '▶ Start the original';
    $('startOriginalBtn').disabled = !androidReady || !!(orig && orig.alive);

    // The in-guest actions only make sense once Android is actually up.
    const origReady = !!(orig && orig.status === 'ready');
    for (const id of ['openSiteBtn', 'installApkBtn', 'pickAppBtn']) $(id).disabled = !origReady;
    $('appNote').textContent = orig && orig.pkg
      ? `The game is ${orig.pkg} — clones made from here launch it on boot.`
      : 'No app chosen yet. Open the site in Android and download the game, or install an APK from this PC.';

    // Keep the instance dropdown in step with the instances that exist.
    const want = m.rows.map((r) => `${r.id}|${r.name}`).join(',');
    const sel = $('cloneFrom');
    if (sel.dataset.sig !== want) {
      sel.dataset.sig = want;
      const keep = Number(sel.value) || ORIGINAL_ID;
      sel.innerHTML = m.rows.map((r) => `<option value="${r.id}">#${r.id} ${esc(r.name)}</option>`).join('');
      sel.value = m.rows.some((r) => r.id === keep) ? String(keep) : String(ORIGINAL_ID);
    }
  }

  /* ---- groups ------------------------------------------------------------
   * A group is a label on an instance. The bar filters the table, and the
   * dashboard has the same filter.
   * ---------------------------------------------------------------------- */
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
      + '<button class="group-new" id="newGroupBtn" title="Make a new group">+ Create group</button>'
      + (groupFilter ? `<button class="group-del" id="delGroupBtn" title="Delete the group ${esc(groupFilter)}. The instances in it are kept.">Delete "${esc(groupFilter)}"</button>` : '');
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
      if (!confirm(`Delete the group "${groupFilter}"?\n\nThe instances in it are kept, they just lose the label.`)) return;
      await window.api.groupDelete(groupFilter).catch(() => {});
      groupFilter = '';
      await loadGroups();
      poll();
    }
  });

  // Moving one instance into a group, straight from its row.
  $('rows').addEventListener('change', async (e) => {
    const sel = e.target.closest('select.row-group');
    if (!sel) return;
    await window.api.groupSet([Number(sel.dataset.id)], sel.value).catch(() => {});
    await loadGroups();
    poll();
  });

  /* ---- saved details ------------------------------------------------------ */
  let credForId = null;

  function setCredVisible(on) {
    $('credPass').type = on ? 'text' : 'password';
    $('credPin').type = on ? 'text' : 'password';
  }

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

  /* ---- the one app -------------------------------------------------------
   * The original downloads the game the way a phone would, or takes an APK
   * from this PC. Either way we end up knowing its package name, and that is
   * what every clone inherits.
   * ---------------------------------------------------------------------- */
  $('openSiteBtn').addEventListener('click', async () => {
    const r = await window.api.openSite(ORIGINAL_ID, $('cfgUrl').value.trim()).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Could not open it.', 'err'); return; }
    msgEl('cfgMsg', 'Opened in the browser inside the original. Watch it in the Dashboard: zoom in on #1 and you can tap and type in it.', 'ok');
  });

  $('installApkBtn').addEventListener('click', async () => {
    msgEl('cfgMsg', 'Installing…', '');
    const r = await window.api.installApk(ORIGINAL_ID, null).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Install failed.', 'err'); return; }
    msgEl('cfgMsg', r.pkg ? `Installed ${r.pkg}. That is now the game for every clone.` : 'Installed.', 'ok');
    poll();
  });

  $('pickAppBtn').addEventListener('click', async () => {
    const r = await window.api.listApps(ORIGINAL_ID).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Could not read the app list.', 'err'); return; }
    if (!r.apps.length) { msgEl('cfgMsg', 'Nothing is installed on the original yet.', 'err'); return; }
    const orig = rowsCache.find((x) => x.original);
    $('appPick').innerHTML = r.apps.map((p) => `<option value="${esc(p)}"${orig && orig.pkg === p ? ' selected' : ''}>${esc(p)}</option>`).join('');
    msgEl('appMsg', '');
    $('appModal').classList.remove('hidden');
  });

  $('appClose').addEventListener('click', () => $('appModal').classList.add('hidden'));
  $('appSave').addEventListener('click', async () => {
    const pkg = $('appPick').value;
    const r = await window.api.setPkg(ORIGINAL_ID, pkg).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('appMsg', (r && r.error) || 'Could not save.', 'err'); return; }
    $('appModal').classList.add('hidden');
    await window.api.launch(ORIGINAL_ID, pkg).catch(() => {});
    msgEl('cfgMsg', `${pkg} is the game now, and it is starting on the original.`, 'ok');
    poll();
  });

  /* ---- update settings -------------------------------------------------- */
  async function loadUpdateCfg() {
    const r = await window.api.updateStatus().catch(() => null);
    if (!r || !r.ok || !r.cfg) return;
    $('updRepo').value = r.cfg.repo || '';
    $('updBranch').value = r.cfg.branch || 'main';
    $('updToken').value = r.cfg.token || '';
    $('updEnabled').checked = r.cfg.enabled !== false;
    const last = r.last;
    // A checkout reports "disabled" with a reason; show the reason, because
    // "up to date" would be a lie about why nothing was pulled.
    $('updStatus').textContent = !last ? 'Not checked yet.'
      : last.error ? last.error
        : last.ok
          ? (last.updated && last.updated.length ? `Updated ${last.updated.length} file(s) — restart to apply.` : 'Up to date.')
          : 'Last check failed.';

    /* Raise the banner from the stored result too, not only from the event.
     *
     * The update runs at launch and can finish BEFORE this window has
     * registered its listener, in which case the message lands nowhere and the
     * app quietly carries on showing the code it loaded with. That is not
     * hypothetical: it produced a control panel from one version sitting
     * beside a dashboard from another, with nothing on screen to explain it.
     * Asking for the last result closes that gap. */
    showUpdate(last);
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
    msgEl('updMsg', 'Checking GitHub…', '');
    const r = await window.api.checkUpdate().catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (!r || !r.ok) { msgEl('updMsg', (r && r.error) || 'Check failed.', 'err'); return; }
    if (r.error) { msgEl('updMsg', r.error, 'err'); loadUpdateCfg(); return; }
    const n = (r.updated || []).length;
    msgEl('updMsg', n ? `Pulled ${n} file${n === 1 ? '' : 's'} — restart to run them.` : 'Connected, and already up to date.', 'ok');
    showUpdate(r);
    loadUpdateCfg();
  });

  /* ---- cloning ----------------------------------------------------------- */
  function renderClone(c) {
    if (!c) return;
    const wrap = $('cloneBarWrap');
    if (c.busy) {
      wrap.classList.remove('hidden');
      $('cloneBar').style.width = c.done + '%';
      $('cloneBtn').disabled = true;
      msgEl('cloneMsg', `Copying onto #${c.newId} ${c.name}… ${gb(c.copiedMB)} of ${gb(c.totalMB)} (${c.done}%)`, '');
      cloneWasBusy = true;
      return;
    }
    if (cloneWasBusy) {
      cloneWasBusy = false;
      wrap.classList.add('hidden');
      $('cloneBtn').disabled = false;
      if (c.error) msgEl('cloneMsg', c.error, 'err');
      else msgEl('cloneMsg', `Done — ${gb(c.copiedMB)} copied. Start the clone and log it into its own account.`, 'ok');
      refreshDisk();
    }
  }

  // The folder scan walks every file and asks the OS for allocated sizes, so
  // it runs on demand rather than on the one-second poll.
  async function refreshDisk() {
    const d = await window.api.disk().catch(() => null);
    if (!d || !d.ok) return;
    const biggest = d.rows.reduce((a, r) => (r.mb > a.mb ? r : a), { id: 0, mb: 0 });
    $('stDiskFree').textContent = (d.freeMB / 1024).toFixed(1);
    $('diskNote').textContent = d.totalMB
      ? `${gb(d.totalMB)} on disk · biggest is #${biggest.id} at ${gb(biggest.mb)} · ${gb(d.freeMB)} free`
      : `Nothing downloaded yet · ${gb(d.freeMB)} free`;
  }

  async function refreshRecSources() {
    const r = await window.api.recSources().catch(() => null);
    const next = new Set(((r && r.ok ? r.ids : []) || []).map(Number));
    // Only force a redraw when it changed — this feeds the row signature.
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
    const n = Math.max(1, Math.min(30, parseInt(count, 10) || 1));
    const go = confirm(
      `Create ${n} clone${n === 1 ? '' : 's'} of ${label}?\n\n`
      + `${label} is shut down while it is copied — copying a running disk image gives you a torn one.`
    );
    if (!go) return;
    $('cloneBtn').disabled = true;
    cloneWasBusy = true;
    $('cloneBarWrap').classList.remove('hidden');
    msgEl('cloneMsg', 'Shutting the source down…', '');
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
      // With nothing recorded here, Play runs the original's recording.
      const rec = recState.get(id) || {};
      const opts = (cmd === 'play' && !rec.steps && recSources.has(ORIGINAL_ID) && id !== ORIGINAL_ID)
        ? { from: ORIGINAL_ID } : undefined;
      const res = await window.api.clickCmd(id, cmd, opts).catch((err) => ({ ok: false, error: err.message }));
      if (res && !res.ok) { msgEl('cfgMsg', res.error, 'err'); return; }
      msgEl('cfgMsg', cmd === 'record'
        ? `Recording on #${id}. Every tap it receives is captured — tap it in the Dashboard — until you press Stop rec.`
        : cmd === 'stopRecord' ? `Recording stopped on #${id}.`
          : cmd === 'play' ? (opts ? `Running the original's recording on #${id}.` : `Replaying on #${id}.`)
            : `Playback stopped on #${id}.`, 'ok');
      refreshRecSources();
      return;
    }

    if (act === 'remove') {
      const row = rowsCache.find((r) => r.id === id);
      if (!confirm(`Delete #${id} ${row ? row.name : ''} and its whole Android image?\n\nThis cannot be undone.`)) return;
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
    msgEl('cfgMsg', 'Booting Android. A cold boot takes about a minute — the row says Ready when it is up.', 'ok');
    poll();
  });

  $('resetOriginalBtn').addEventListener('click', async () => {
    if (!confirm('Reset the original?\n\nIts Android image is deleted: the game, its downloads and its login all go. Clones already made are untouched.')) return;
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
    if (r && r.ok) {
      msgEl('cfgMsg', r.opened
        ? `Booting ${r.opened}. They are virtual machines, so give them a minute.`
        : 'Everything is already running.', 'ok');
    }
    poll();
    setTimeout(poll, 2000);
  });

  $('stopAllBtn').addEventListener('click', async () => {
    msgEl('cfgMsg', 'Shutting the guests down cleanly…', '');
    await window.api.stopAll().catch(() => {});
    msgEl('cfgMsg', 'Stopped.', 'ok');
    poll();
  });

  $('stageBtn').addEventListener('click', async () => {
    const r = await window.api.openStage().catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) { msgEl('cfgMsg', r.error, 'err'); return; }
    msgEl('cfgMsg', 'Dashboard opened.', 'ok');
  });

  $('applyBtn').addEventListener('click', async () => {
    const r = await window.api.apply(readForm()).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Could not save.', 'err'); return; }
    msgEl('cfgMsg', r.note || 'Saved.', 'ok');
  });

  /* ---- code updates ----------------------------------------------------- */
  // The app pulls its own source from GitHub on launch. Anything that changed
  // is already on disk by the time this banner appears; a restart is what
  // actually loads it.
  function showUpdate(r) {
    if (!r || !r.ok) return;           // a failed check stays quiet
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

  /* Restart now.
   *
   * This waits for an answer instead of firing and forgetting: a portable
   * build cannot always relaunch itself, and clicking Restart and watching
   * nothing happen is the worst possible outcome. If it cannot restart, say
   * so, in the banner, where the button was. */
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
    // On success the window is about to go away, so leave the button alone.
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
    await checkAndroid();
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
