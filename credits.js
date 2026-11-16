// Participation credits for the Class Wheel.
// Award +2 / +1 / 0 after a spin (or by tapping a name), keep every award on this
// device first, then sync to a Google Sheet through a small Apps Script web app.
// Setup: see apps-script/Code.gs and the README.
//
// Loaded before the main script; uses its globals ($, S, B, DATA, mk, save, refresh,
// renderBatchSeg, batchTitle, shuffle, randInt, toast, esc, showModal, closeModal,
// lastPick, spinning) only inside functions, so load order is fine.
const CR = (() => {
  const CFG_KEY = 'classWheel:credits-cfg:v1', DATA_KEY = 'classWheel:credits:v1', ROSTER_KEY = 'classWheel:roster:v1';
  const cfg = { url: '', key: '', cap: 0, favour: false, tap: 'absent' };
  let snap = {}, snapDate = '', pending = [], sheetUrl = '';
  let lastAward = null, syncing = false, fetching = false, gen = 0, state = 'idle', errMsg = '', timer = null;
  let inFlight = new Set();

  /* ---------- small helpers ---------- */
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + randInt(1e9).toString(36);
  const connected = () => !!(cfg.url && cfg.key);
  const labelOf = id => batchTitle(id);
  const idFor = label => { const l = String(label).trim().toLowerCase(); return DATA.batches.find(b => b.id.toLowerCase() === l || b.title.toLowerCase() === l)?.id; };
  const plus = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  function readJSON(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } }
  function writeJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
  function persist(){ writeJSON(DATA_KEY, { snap, snapDate, pending, sheetUrl }); }
  function saveCfg(){ writeJSON(CFG_KEY, cfg); }

  /** Call before the main load(): restores settings, unsynced credits and the last roster from the Sheet. */
  function loadLocal(){
    Object.assign(cfg, readJSON(CFG_KEY) || {});
    const d = readJSON(DATA_KEY) || {};
    snap = d.snap || {}; snapDate = d.snapDate || ''; pending = Array.isArray(d.pending) ? d.pending : []; sheetUrl = d.sheetUrl || '';
    const roster = readJSON(ROSTER_KEY) || {};
    DATA.batches.forEach(b => { if (Array.isArray(roster[b.id]) && roster[b.id].length) b.names = roster[b.id]; });
  }

  /* ---------- credits ---------- */
  /** Sheet totals plus anything still waiting on this device. */
  function get(name, id = S.current){
    const label = labelOf(id), base = snap[label]?.[name] || {}, t = today();
    const o = { total: base.total || 0, today: snapDate === t ? (base.today || 0) : 0, n: base.n || 0 };
    pending.forEach(ev => {
      if (ev.batch !== label || ev.name !== name) return;
      o.total += ev.points; if (ev.date === t) o.today += ev.points; o.n += ev.source === 'undo' ? -1 : 1;
    });
    return o;
  }

  function award(name, points, source){
    const id = S.current, cur = get(name, id);
    if (cfg.cap > 0 && points > 0 && cur.today + points > cfg.cap){
      toast(`${name} already has ${cur.today} today. Daily cap is ${cfg.cap}.`); return false;
    }
    const ev = { id: uid(), t: new Date().toISOString(), batch: labelOf(id), name, points, source, date: today(), note: '' };
    pending.push(ev); lastAward = ev; persist();
    toast(points ? `${plus(points)} → ${name}` : `Noted: ${name} (0)`);
    refresh(); scheduleSync(300);
    return true;
  }

  function undo(){
    const a = lastAward; if (!a) return;
    lastAward = null;
    const i = pending.findIndex(ev => ev.id === a.id);
    if (i >= 0 && !inFlight.has(a.id)) pending.splice(i, 1);          // never left this device: just drop it
    else pending.push({ ...a, id: uid(), t: new Date().toISOString(), points: -a.points, source: 'undo', note: 'undo ' + a.id });
    persist(); toast(`Undone: ${a.name} ${plus(a.points)}`); refresh(); scheduleSync(300);
  }

  /** Random winners; with "favour fewer credits" on, low scorers are more likely (weight 1 / (1 + credits)). */
  function pickWinners(pool, k){
    if (!cfg.favour) return shuffle(pool).slice(0, k);
    const left = pool.slice(), out = [];
    while (out.length < k && left.length){
      const w = left.map(n => 1 / (1 + Math.max(0, get(n.name).total)));
      let r = randInt(1e9) / 1e9 * w.reduce((a, b) => a + b, 0), i = 0;
      while (i < left.length - 1 && (r -= w[i]) >= 0) i++;
      out.push(left.splice(i, 1)[0]);
    }
    return out;
  }

  /* ---------- talking to the Sheet ---------- */
  async function call(method, payload){
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 25000);
    try {
      let r;
      if (method === 'GET') r = await fetch(`${cfg.url}?${new URLSearchParams({ ...payload, key: cfg.key })}`, { signal: ctrl.signal });
      else r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...payload, key: cfg.key }), signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let res; try { res = await r.json(); } catch(e){ throw new Error('Not a JSON reply. Use the /exec web app URL.'); }
      if (!res.ok) throw new Error(res.error || 'Sheet error');
      return res;
    } catch(err){
      if (err.name === 'AbortError') throw new Error('Timed out');
      if (err instanceof TypeError) throw new Error('Can’t reach the Sheet (offline, or web app access isn’t “Anyone”)');
      throw err;
    } finally { clearTimeout(to); }
  }

  function scheduleSync(ms){ clearTimeout(timer); timer = setTimeout(sync, ms); }

  async function sync(){
    if (!connected() || syncing || !pending.length){ render(); return; }
    syncing = true; state = 'syncing'; render();
    const batch = pending.slice(0, 200); inFlight = new Set(batch.map(e => e.id));
    try {
      const res = await call('POST', { action: 'award', events: batch, date: today() });
      const done = new Set(res.accepted || []);
      pending = pending.filter(ev => !done.has(ev.id));
      if (res.totals){ snap = res.totals; snapDate = today(); gen++; }
      if (res.rejected?.length) toast(`${res.rejected.length} credit(s) were rejected by the Sheet`);
      state = 'ok'; errMsg = '';
    } catch(err){ state = 'error'; errMsg = err.message; }
    syncing = false; inFlight = new Set(); persist(); refresh();
    if (state === 'ok' && pending.length) scheduleSync(100);
  }

  /** Pull totals (and optionally the roster) from the Sheet. */
  async function fetchState(withRoster){
    if (!connected() || fetching) return null;
    fetching = true; const g = gen;
    try {
      const res = await call('GET', { action: 'state', date: today() });
      if (g === gen && !syncing){ snap = res.totals || {}; snapDate = today(); }   // skip if a sync landed meanwhile
      sheetUrl = res.sheetUrl || sheetUrl;
      if (withRoster) applyRoster(res.roster || {});
      if (!syncing){ state = 'ok'; errMsg = ''; }
      persist(); refresh();
      return res;
    } catch(err){ state = 'error'; errMsg = err.message; render(); return null; }
    finally { fetching = false; }
  }

  /** Sheet roster → wheel. Keeps absent/picked marks and history for names that stay. */
  function applyRoster(map){
    if (spinning){ setTimeout(() => applyRoster(map), 1500); return 0; }
    const cache = readJSON(ROSTER_KEY) || {}; let total = 0;
    Object.entries(map).forEach(([label, names]) => {
      const id = idFor(label);
      if (!id || !Array.isArray(names) || !names.length) return;
      cache[id] = names; DATA.batches.find(b => b.id === id).names = names;
      const old = S.batches[id], prev = new Map((old?.names || []).map(n => [n.name.toLowerCase(), n]));
      S.batches[id] = { custom: false, names: names.map(n => { const p = prev.get(n.toLowerCase()); return mk(n, !!p?.absent, !!p?.picked); }), history: old?.history || [] };
      lastPick[id] = null; total += names.length;
    });
    if (!total) return 0;
    writeJSON(ROSTER_KEY, cache); save();
    renderBatchSeg(); $('names').value = B().names.map(n => n.name).join('\n'); refresh();
    $('live').textContent = `${batchTitle(S.current)} ready — ${onWheel().length} on the wheel`;
    return total;
  }

  /** After uploading / editing a list in "Manage roster", write it to the Sheet too. */
  function pushRoster(id, names){
    if (!connected()) return;
    call('POST', { action: 'setRoster', batch: labelOf(id), names })
      .then(() => { const c = readJSON(ROSTER_KEY) || {}; c[id] = names; writeJSON(ROSTER_KEY, c); toast(`Roster saved to the Sheet (${names.length} names)`); })
      .catch(err => toast('Saved here, but the Sheet roster was not updated: ' + err.message));
  }

  async function reloadRoster(){
    const res = await fetchState(true);
    if (!res) return toast('Could not reach the Sheet: ' + errMsg);
    const n = Object.entries(res.roster || {}).filter(([l]) => idFor(l)).reduce((a, [, v]) => a + v.length, 0);
    toast(n ? `Loaded ${n} names from the Sheet` : 'The Roster tab is empty. Add rows: Batch | Name');
  }

  /* ---------- UI ---------- */
  function statusBadge(){
    const n = pending.length;
    if (!connected()) return ['grey', n ? `Not connected · ${n} saved on this device` : 'Not connected · credits stay on this device'];
    if (state === 'syncing') return ['', `Syncing ${n}…`];
    if (state === 'error') return ['amber', `⚠ ${n ? n + ' waiting · ' : ''}${errMsg}`];
    return n ? ['amber', `${n} waiting to sync`] : ['green', '✓ Synced with Sheet'];
  }

  function render(){
    if (!$('crBoard')) return;
    const [cls, txt] = statusBadge(), st = $('crStatus');
    st.className = 'badge ' + cls; st.textContent = txt; st.title = errMsg;
    $('crBatch').textContent = batchTitle(S.current);
    $('crUndoBtn').disabled = !lastAward;
    $('crSyncBtn').disabled = !connected() || syncing;
    $('crSheetLink').hidden = !sheetUrl; if (sheetUrl) $('crSheetLink').href = sheetUrl;
    const rows = B().names.map(n => ({ name: n.name, ...get(n.name) }));
    const ranked = rows.filter(r => r.total || r.n).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const quiet = rows.length - ranked.length;
    $('crBoard').innerHTML = ranked.length
      ? ranked.map((r, i) => `<div class="cr-row"><span class="cr-rank">${i + 1}</span><span class="cr-name">${esc(r.name)}</span>` +
          `${r.today ? `<small class="cr-today${r.today < 0 ? ' neg' : ''}">${plus(r.today)} today</small>` : ''}<b${r.total < 0 ? ' class="neg"' : ''}>${r.total}</b></div>`).join('') +
        (quiet ? `<p class="hint">${quiet} student${quiet === 1 ? '' : 's'} with no credits yet</p>` : '')
      : '<p class="hint">No credits yet. Spin, then press +2 / +1 / 0.</p>';
  }

  /** Chip badge number (0 → none). */
  const chipCount = name => get(name).total;

  /** +2 / +1 / 0 buttons. solo = one big set under a single pick (keys 2/1/0 work). */
  function awardBlock(name, source, solo){
    const c = get(name), lbl = (p, t) => `${p}${solo ? ` <small>${t}</small>` : ''}`;
    return `<div class="award${solo ? ' solo' : ''}" data-name="${esc(name)}" data-src="${source}"${solo ? ' data-solo="1"' : ''}>` +
      (solo ? '' : `<span class="award-name">${esc(name)}</span>`) +
      `<button class="btn pts p2" data-pts="2">${lbl('+2', 'good answer')}</button>` +
      `<button class="btn pts p1" data-pts="1">${lbl('+1', 'tried')}</button>` +
      `<button class="btn pts p0" data-pts="0">${lbl('0', 'no answer')}</button>` +
      `<button class="btn pts pn" data-pts="-1">${lbl('−1', 'penalty')}</button>` +
      `<button class="btn pts pn" data-pts="-2">${lbl('−2', 'penalty')}</button>` +
      (solo ? `<p class="hint">${c.total} credit${Math.abs(c.total) === 1 ? '' : 's'} so far${c.today ? ` · ${plus(c.today)} today` : ''} · keys <kbd>2</kbd> <kbd>1</kbd> <kbd>0</kbd> <kbd>-</kbd> · <kbd>Space</kbd> skip</p>` : '') +
      `</div>`;
  }

  function openManual(name){
    showModal('⭐ Give credit', `<div class="winners"><span class="winner solo">${esc(name)}</span></div>` + awardBlock(name, 'manual', true), name);
  }

  function onAwardClick(e){
    const b = e.target.closest('[data-pts]'); if (!b || b.disabled) return;
    const w = b.closest('.award');
    if (!award(w.dataset.name, +b.dataset.pts, w.dataset.src)) return;
    if (w.dataset.solo) return closeModal();
    w.classList.add('done'); w.querySelectorAll('button').forEach(x => { x.disabled = true; }); b.classList.add('on');
  }

  const tapMode = () => cfg.tap;
  function setTap(m){
    cfg.tap = m === 'award' ? 'award' : 'absent'; saveCfg();
    [...$('tapSeg').children].forEach(b => b.classList.toggle('on', b.dataset.tap === cfg.tap));
    $('legend').hidden = cfg.tap === 'award'; $('awardHint').hidden = cfg.tap !== 'award';
  }

  function init(){
    $('crUrl').value = cfg.url; $('crKey').value = cfg.key; $('crCap').value = cfg.cap || 0; $('crFavour').checked = !!cfg.favour;
    setTap(cfg.tap);
    $('tapSeg').onclick = e => { const b = e.target.closest('button'); if (b) setTap(b.dataset.tap); };
    $('crSaveBtn').onclick = async () => {
      const url = $('crUrl').value.trim(), key = $('crKey').value.trim();
      if (url && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return toast('Paste the web app URL: it starts with https://script.google.com/ and ends with /exec');
      cfg.url = url; cfg.key = key; saveCfg(); state = 'idle'; errMsg = '';
      if (!connected()){ render(); return toast('Enter both the web app URL and the key'); }
      toast('Connecting…');
      const res = await fetchState(true);
      if (!res) return toast('Could not connect: ' + errMsg);
      const counts = DATA.batches.map(b => `${b.title}: ${Object.entries(res.roster || {}).find(([l]) => idFor(l) === b.id)?.[1].length || 0}`).join(' · ');
      toast(`Connected ✓  ${counts}`); $('crSetup').open = false; sync();
    };
    $('crDisconnectBtn').onclick = () => {
      if (!confirm('Disconnect this device from the Sheet? Credits not yet synced stay saved here.')) return;
      cfg.url = cfg.key = ''; saveCfg(); $('crUrl').value = $('crKey').value = ''; state = 'idle'; errMsg = ''; render();
    };
    $('crCap').onchange = () => { cfg.cap = Math.max(0, parseInt($('crCap').value) || 0); $('crCap').value = cfg.cap; saveCfg(); };
    $('crFavour').onchange = () => { cfg.favour = $('crFavour').checked; saveCfg(); };
    $('crSyncBtn').onclick = async () => { await sync(); await fetchState(false); };
    $('crUndoBtn').onclick = undo;
    $('crSetup').open = !connected();

    setInterval(() => { if (pending.length && !syncing) sync(); }, 20000);
    setInterval(() => { if (document.visibilityState === 'visible' && !syncing) fetchState(false); }, 120000);
    addEventListener('online', () => sync());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible'){ sync(); fetchState(false); } });
    render();
    if (connected()) fetchState(true).then(() => sync());
  }

  return { loadLocal, init, render, get, chipCount, award, undo, pickWinners, awardBlock, openManual, onAwardClick,
           tapMode, connected, pushRoster, reloadRoster, sync, fetchState, call, idFor, url: () => cfg.url };
})();
