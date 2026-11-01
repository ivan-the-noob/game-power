/* ===========================================================================
 * Game Power — control panel.
 *
 * One original, and clones made from it. The numbers on screen come from
 * Chromium's own per-process accounting, so the RAM column is what each
 * instance actually costs rather than an estimate.
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
  let groupFilter = '';      // '' = All
  // id -> { steps, recording, playing } as reported from inside each instance
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

  /* ---- settings --------------------------------------------------------- */
  function readForm() {
    return {
      url: $('cfgUrl').value.trim(),
      phoneMode: $('cfgPhone').checked,
      muted: $('cfgMuted').checked,
      fps: Number($('cfgFps').value) || 0,
      dpr: (Number($('cfgDpr').value) || 0) / 100,
      recLoops: Number($('cfgLoops').value) || 0,
      recLoopGapMin: Number($('cfgLoopGapMin').value) || 0,
      recLoopGap: Number($('cfgLoopGap').value) || 0,
      recSpeed: Number($('cfgSpeed').value) || 1,
      recFixedGap: Number($('cfgFixedGap').value) || 0,
    };
  }

  function writeForm(s) {
    $('cfgUrl').value = s.url;
    $('cfgPhone').checked = !!s.phoneMode;
    $('cfgMuted').checked = !!s.muted;
    $('cfgFps').value = s.fps || 0;
    $('cfgDpr').value = Math.round((s.dpr || 0) * 100);
    $('cfgLoops').value = s.recLoops != null ? s.recLoops : 0;
    $('cfgLoopGapMin').value = s.recLoopGapMin != null ? s.recLoopGapMin : 0;
    $('cfgLoopGap').value = s.recLoopGap != null ? s.recLoopGap : 1;
    $('cfgSpeed').value = s.recSpeed != null ? s.recSpeed : 1;
    $('cfgFixedGap').value = s.recFixedGap != null ? s.recFixedGap : 0;
    paintSliders();
  }

  function paintSliders() {
    const fps = Number($('cfgFps').value) || 0;
    const dpr = Number($('cfgDpr').value) || 0;
    $('cfgFpsOut').textContent = fps ? fps + ' fps' : 'Uncapped';
    $('cfgDprOut').textContent = dpr ? dpr + '%' : 'Native';
  }

  /* ---- monitor ---------------------------------------------------------- */
  const ramClass = (mb) => (mb > 700 ? 'max' : mb > 400 ? 'hot' : '');

  /* ---- the table ----------------------------------------------------------
   * This redraws once a second, and rebuilding the rows wholesale would throw
   * away whatever you were in the middle of — an open group dropdown closed
   * itself the moment the mouse moved. So the rebuild only happens when the
   * rows actually change shape; the rest of the time RAM, CPU and uptime are
   * written straight into the cells that already exist. And a rebuild never
   * runs while something in the table has focus: it waits until you are done.
   * ------------------------------------------------------------------------ */
  let lastSig = '';
  let rebuildWanted = false;

  const rowSignature = (rows) => rows.map((r) => {
    const rec = recState.get(r.id) || {};
    return [r.id, r.name, r.group || '', r.alive ? 1 : 0, r.hasCred ? 1 : 0,
      rec.recording ? 1 : 0, rec.playing ? 1 : 0, rec.steps || 0].join('|');
  }).join(';') + '::' + groupsCache.join(',');

  function updateInPlace(rows, peak) {
    for (const r of rows) {
      const tr = $('rows').querySelector(`tr[data-id="${r.id}"]`);
      if (!tr) continue;
      const cell = (n) => tr.children[n];
      if (r.alive) {
        const bar = cell(4).querySelector('i');
        cell(4).querySelector('.num').textContent = r.ramMB;
        if (bar) {
          bar.className = ramClass(r.ramMB);
          bar.style.width = Math.min(100, Math.round((r.ramMB / peak) * 100)) + '%';
        }
        cell(5).querySelector('.num').textContent = r.cpu.toFixed(1);
        cell(6).querySelector('.num').textContent = r.upMin;
      }
    }
  }

  // Once you stop interacting with the table, catch up on anything deferred.
  $('rows').addEventListener('focusout', () => {
    if (rebuildWanted) { rebuildWanted = false; lastSig = ''; poll(); }
  });

  function renderRows(m) {
    rowsCache = m.rows;
    const body = $('rows');
    // "All" shows everything; a chosen group narrows the table to its members.
    const shown = groupFilter ? m.rows.filter((r) => (r.group || '') === groupFilter) : m.rows;
    if (!shown.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">Nothing in "${esc(groupFilter)}" yet. Pick a group on a row to move it here.</td></tr>`;
      lastSig = '';
      return;
    }
    const peak = Math.max(300, ...shown.map((r) => r.ramMB));
    const sig = rowSignature(shown);
    if (sig === lastSig) { updateInPlace(shown, peak); return; }
    // Something structural changed — but never yank a control out from under
    // the mouse. Hold the rebuild until focus leaves the table.
    if (body.contains(document.activeElement)) { rebuildWanted = true; updateInPlace(shown, peak); return; }
    lastSig = sig;
    body.innerHTML = shown.map((r) => {
      const status = r.alive ? '<span class="pill on">Running</span>' : '<span class="pill off">Stopped</span>';
      const ram = r.alive
        ? `<span class="num">${r.ramMB}</span> MB<div class="bar"><i class="${ramClass(r.ramMB)}" style="width:${Math.min(100, Math.round((r.ramMB / peak) * 100))}%"></i></div>`
        : '<span class="num dim">—</span>';
      const cpu = r.alive ? `<span class="num">${r.cpu.toFixed(1)}</span>%` : '<span class="num dim">—</span>';
      const up = r.alive ? `<span class="num">${r.upMin}</span>m` : '<span class="dim">—</span>';
      let gfx = '<span class="pill off">—</span>';
      if (r.alive && r.tuned) {
        const bits = [];
        if (r.tuned.fps) bits.push(r.tuned.fps + ' fps');
        if (r.tuned.dpr) bits.push(Math.round(r.tuned.dpr * 100) + '%');
        gfx = bits.length ? `<span class="pill on">${esc(bits.join(' · '))}</span>` : '<span class="pill off">Native</span>';
      } else if (r.alive) {
        gfx = '<span class="pill warn" title="Still loading, or the overrides could not be applied">pending</span>';
      }
      const tag = r.original
        ? '<span class="tag orig">original</span>'
        : (r.from ? `<span class="tag" title="Cloned from instance #${r.from}">from #${r.from}</span>` : '');
      const rec = recState.get(r.id) || {};
      const acts = r.alive
        ? `${rec.recording
            ? `<button class="tiny danger-on" data-act="stopRecord" data-id="${r.id}" title="Stop recording">■ Stop rec</button>`
            : `<button class="tiny" data-act="record" data-id="${r.id}" title="Record every click you make, until you stop">● Rec</button>`}
           ${rec.playing
            ? `<button class="tiny go-on" data-act="stopPlay" data-id="${r.id}" title="Stop playback">⏹ Stop</button>`
            : `<button class="tiny" data-act="play" data-id="${r.id}" title="Replay the recording on a loop"${rec.steps ? '' : ' disabled'}>▶ Play</button>`}
           <span class="steps" title="Clicks recorded in this instance">${rec.steps || 0}</span>
           <button class="tiny" data-act="focus" data-id="${r.id}">Show</button>
           <button class="tiny" data-act="reload" data-id="${r.id}">Reload</button>
           <button class="tiny" data-act="stop" data-id="${r.id}">Stop</button>`
        : `<button class="tiny" data-act="start" data-id="${r.id}">Start</button>
           <button class="tiny" data-act="cloneThis" data-id="${r.id}" title="Make a new instance that is a copy of this one">Clone</button>
           ${r.original ? '' : `<button class="tiny" data-act="remove" data-id="${r.id}" title="Delete this clone and its data">Delete</button>`}`;
      const opts = ['', ...groupsCache].map((g) =>
        `<option value="${esc(g)}"${(r.group || '') === g ? ' selected' : ''}>${g ? esc(g) : '— none —'}</option>`).join('');
      const details = `<button class="tiny${r.hasCred ? ' has-cred' : ''}" data-act="cred" data-id="${r.id}" title="${r.hasCred ? 'Saved details for this account' : 'Save the login details for this account'}">${r.hasCred ? '🔑' : '🔑'} Details</button>`;
      return `<tr data-id="${r.id}">
        <td class="idx num">#${r.id}</td>
        <td class="name" data-act="rename" data-id="${r.id}" title="Double-click to rename">${esc(r.name)}${tag}</td>
        <td><select class="row-group" data-id="${r.id}" title="Move this instance to a group">${opts}</select></td>
        <td>${status}</td>
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
    $('stShared').textContent = m.sharedMB;
    $('stTotal').textContent = m.totalMB;
    $('stEach').textContent = m.perInstanceMB;
    $('monitorNote').textContent = m.running ? `${m.running} running · refreshing every second` : 'Nothing running.';
    $('stopAllBtn').disabled = m.running === 0;
    $('tileBtn').disabled = m.running === 0;

    const orig = m.rows.find((r) => r.original);
    $('originNote').textContent = orig
      ? (orig.alive ? `Running · ${orig.ramMB} MB` : 'Stopped')
      : '—';
    $('startOriginalBtn').textContent = orig && orig.alive ? '▶ Show the original' : '▶ Start the original';

    // Keep the instance dropdowns in step with the instances that exist.
    const want = m.rows.map((r) => `${r.id}|${r.name}`).join(',');
    for (const selId of ['cloneFrom']) {
      const sel = $(selId);
      if (sel.dataset.sig === want) continue;
      sel.dataset.sig = want;
      const keep = Number(sel.value) || ORIGINAL_ID;
      sel.innerHTML = m.rows.map((r) => `<option value="${r.id}">#${r.id} ${esc(r.name)}</option>`).join('');
      sel.value = m.rows.some((r) => r.id === keep) ? String(keep) : String(ORIGINAL_ID);
    }
  }

  /* ---- groups ------------------------------------------------------------
   * A group is a label on an instance. The bar filters the table, and the
   * dashboard has the same filter, so you can put thirty instances in
   * "Farming" and only load those.
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
    const id = Number(sel.dataset.id);
    await window.api.groupSet([id], sel.value).catch(() => {});
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

  /* ---- update settings -------------------------------------------------- */
  async function loadUpdateCfg() {
    const r = await window.api.updateStatus().catch(() => null);
    if (!r || !r.ok || !r.cfg) return;
    $('updRepo').value = r.cfg.repo || '';
    $('updBranch').value = r.cfg.branch || 'main';
    $('updToken').value = r.cfg.token || '';
    $('updEnabled').checked = r.cfg.enabled !== false;
    const last = r.last;
    $('updStatus').textContent = !last ? 'Not checked yet.'
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
    msgEl('updMsg', 'Checking GitHub…', '');
    const r = await window.api.checkUpdate().catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (!r || !r.ok) { msgEl('updMsg', (r && r.error) || 'Check failed.', 'err'); return; }
    const n = (r.updated || []).length;
    msgEl('updMsg', n ? `Pulled ${n} file${n === 1 ? '' : 's'} — restart to run them.` : 'Connected, and already up to date.', 'ok');
    showUpdate(r);
    loadUpdateCfg();
  });

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

  // The folder scan walks every cached file, so it runs on demand rather than
  // on the one-second poll.
  async function refreshDisk() {
    const d = await window.api.disk().catch(() => null);
    if (!d || !d.ok) return;
    const biggest = d.rows.reduce((a, r) => (r.mb > a.mb ? r : a), { id: 0, mb: 0 });
    $('diskNote').textContent = d.totalMB
      ? `${gb(d.totalMB)} on disk · biggest is #${biggest.id} at ${gb(biggest.mb)}`
      : 'Nothing downloaded yet.';
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
      `Create ${n} clone${n === 1 ? '' : 's'} of ${label}?\n\n` +
      `${label} is closed while it is copied, and each clone needs as much free disk space as it uses.`
    );
    if (!go) return;
    $('cloneBtn').disabled = true;
    cloneWasBusy = true;
    $('cloneBarWrap').classList.remove('hidden');
    msgEl('cloneMsg', 'Closing the source…', '');
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
    // Recorder: the recording and replaying happen inside the instance; this
    // only sends the command and shows what comes back.
    if (['record', 'stopRecord', 'play', 'stopPlay'].includes(act)) {
      const cmd = act === 'stopPlay' ? 'stop' : act;
      const res = await window.api.clickCmd(id, cmd).catch((err) => ({ ok: false, error: err.message }));
      if (res && !res.ok) { msgEl('cfgMsg', res.error, 'err'); return; }
      msgEl('cfgMsg', cmd === 'record'
        ? `Recording in #${id}. Every click you make in it is captured until you press Stop rec.`
        : cmd === 'stopRecord' ? `Recording stopped in #${id}.`
          : cmd === 'play' ? `Replaying in #${id}.` : `Playback stopped in #${id}.`, 'ok');
      return;
    }
    if (act === 'remove') {
      const row = rowsCache.find((r) => r.id === id);
      if (!confirm(`Delete #${id} ${row ? row.name : ''} and everything it has downloaded?\n\nThis cannot be undone.`)) return;
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
    const orig = rowsCache.find((r) => r.original);
    if (orig && orig.alive) { await window.api.focus(orig.id).catch(() => {}); return; }
    await window.api.start(ORIGINAL_ID).catch(() => {});
    poll();
  });

  $('resetOriginalBtn').addEventListener('click', async () => {
    if (!confirm('Reset the original?\n\nIts login and everything it has downloaded are deleted. Clones already made are untouched.')) return;
    const r = await window.api.reset(ORIGINAL_ID).catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) msgEl('cfgMsg', r.error, 'err');
    poll();
    refreshDisk();
  });

  $('startAllBtn').addEventListener('click', async () => {
    $('startAllBtn').disabled = true;
    const r = await window.api.startAll().catch(() => null);
    $('startAllBtn').disabled = false;
    if (r && r.ok) msgEl('cfgMsg', r.opened ? `Started ${r.opened}.` : 'Everything is already running.', 'ok');
    poll();
    setTimeout(poll, 1500);
  });

  $('stopAllBtn').addEventListener('click', async () => {
    await window.api.stopAll().catch(() => {});
    poll();
  });

  $('stageBtn').addEventListener('click', async () => {
    const r = await window.api.openStage().catch((e) => ({ ok: false, error: e.message }));
    if (r && !r.ok) { msgEl('cfgMsg', r.error, 'err'); return; }
    msgEl('cfgMsg', 'Dashboard opened. Loose windows were closed — an instance can only run in one place at a time.', 'ok');
    poll();
  });

  $('tileBtn').addEventListener('click', async () => {
    const r = await window.api.tile().catch(() => null);
    if (r && r.ok && r.tiled) msgEl('cfgMsg', `Tiled ${r.tiled} window${r.tiled === 1 ? '' : 's'} into ${r.cols} × ${r.rows}.`, 'ok');
  });

  $('applyBtn').addEventListener('click', async () => {
    const r = await window.api.apply(readForm()).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { msgEl('cfgMsg', (r && r.error) || 'Could not save.', 'err'); return; }
    msgEl('cfgMsg', 'Saved. Frame rate and render scale apply to instances started from now on.', 'ok');
  });

  ['cfgFps', 'cfgDpr'].forEach((id) => $(id).addEventListener('input', paintSliders));

  /* ---- code updates ----------------------------------------------------- */
  // The app pulls its own source from GitHub on launch. Anything that changed
  // is already on disk by the time this banner appears; a restart is what
  // actually loads it.
  function showUpdate(r) {
    const bar = $('updateBar');
    if (!r) return;
    // A failed check stays quiet. The app keeps running the code it has, so a
    // red bar across the top every launch is noise, not news — the Updates
    // card still says so for anyone who goes looking.
    if (!r.ok) return;
    if (!r.updated || !r.updated.length) return;   // already current, say nothing
    bar.classList.remove('hidden', 'err');
    $('updateRestart').classList.remove('hidden');
    const n = r.updated.length;
    $('updateText').textContent = `Updated ${n} file${n === 1 ? '' : 's'} from GitHub — restart to run the new code.`;
  }

  if (window.api.onUpdateResult) window.api.onUpdateResult(showUpdate);
  $('updateDismiss').addEventListener('click', () => $('updateBar').classList.add('hidden'));
  $('updateRestart').addEventListener('click', () => window.api.restart().catch(() => {}));
  $('checkUpdateBtn').addEventListener('click', async () => {
    const btn = $('checkUpdateBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const r = await window.api.checkUpdate().catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    btn.textContent = 'Check for updates';
    if (r && r.ok && (!r.updated || !r.updated.length)) msgEl('cfgMsg', 'Already running the newest code.', 'ok');
    showUpdate(r);
  });

  /* ---- go --------------------------------------------------------------- */
  (async function start() {
    const s = await window.api.getSettings().catch(() => null);
    if (s && s.ok) { ORIGINAL_ID = s.originalId || 1; writeForm(s.settings); }
    const v = await window.api.version().catch(() => null);
    if (v && v.ok) $('footVersion').textContent = `v${v.version} · Chromium ${String(v.chrome).split('.')[0]}`;
    await loadGroups();
    await poll();
    renderGroupBar();
    refreshDisk();
    loadUpdateCfg();
    setInterval(() => { if (!document.hidden) poll(); }, 1000);
  })();
})();
