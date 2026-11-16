// Hands up: a QR beside the wheel. Students scan it, type part of their name or their
// roll number on join.html, and join a queue in the order they raised their hands.
// You press "Pick next" (or N) and get the usual credit buttons.
// Needs the Google Sheet connection (uses CR.call). Loaded before the main script;
// uses its globals only inside functions.
const HU = (() => {
  let round = null, queue = [], timer = null, busy = false, qrFor = '', lastErr = '';
  const done = new Set();   // ids picked/removed here but maybe not yet reflected by the Sheet

  const depId = () => (CR.url().match(/\/macros\/s\/([^/]+)\/exec/) || [])[1] || '';
  const joinUrl = () => `${new URL('join.html', location.href).href}#d=${depId()}&c=${round.code}`;
  const isOpen = () => !!round;
  function ago(t){ const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; }
  function qrSvg(text, cell){ const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: cell, margin: 2, scalable: true }); }

  async function start(){
    if (!CR.connected()){ toast('Connect the Google Sheet first (Credits card)'); $('crSetup').open = true; return; }
    if (round && !confirm('Start a new hands-up round? The current queue will be cleared.')) return;
    try {
      const res = await CR.call('POST', { action: 'openRound', batch: batchTitle(S.current) });
      round = res.round; queue = []; done.clear(); lastErr = ''; render(); schedule(2500);
      toast(`Hands-up open for ${round.batch} · code ${round.code}`);
    } catch(e){ toast('Could not start hands-up: ' + e.message); }
  }

  async function stop(){
    if (queue.length && !confirm(`End hands-up? ${queue.length} student(s) still in the queue will be cleared.`)) return;
    clearTimeout(timer); round = null; queue = []; render();
    try { await CR.call('POST', { action: 'closeRound' }); } catch(e){ toast('Ended here, but the Sheet was not updated: ' + e.message); }
  }

  function schedule(ms){ clearTimeout(timer); timer = setTimeout(poll, ms); }

  async function poll(){
    if (!CR.connected()) return;
    if (document.visibilityState === 'visible' && !busy){
      busy = true;
      try {
        const res = await CR.call('GET', { action: 'queue' });
        const was = round;
        round = res.round && res.round.open ? res.round : null;
        queue = (res.queue || []).filter(h => !done.has(h.id));
        lastErr = '';
        if (was && !round) toast('Hands-up round has ended');
        render();
      } catch(e){ lastErr = e.message; render(); }
      busy = false;
    }
    if (round) schedule(3000);
  }

  function take(id, status){
    done.add(id); queue = queue.filter(h => h.id !== id); render();
    CR.call('POST', { action: 'handDone', id, status }).catch(e => toast('Queue not updated on the Sheet: ' + e.message));
  }

  function pick(id){
    const h = queue.find(x => x.id === id); if (!h || spinning) return;
    take(id, 'picked');
    const bid = CR.idFor(round.batch);
    if (bid && bid !== S.current) switchBatch(bid);
    const n = B().names.find(x => x.name === h.name);
    if (n){ n.picked = true; save(); refresh(); }
    record('Hands up', [h.name]); ding();
    showWinners([h.name], 'queue', `✋ ${h.name.split(' ')[0]}, your turn`);
  }
  const pickNext = () => { if (queue[0]) pick(queue[0].id); else if (round) toast('No hands in the queue'); };
  function remove(id){ take(id, 'removed'); }

  function enlarge(){
    if (!round) return;
    showModal(`✋ Scan to raise your hand · ${round.batch}`,
      `<div class="qr-big">${qrSvg(joinUrl(), 8)}</div><div class="hu-code big">Code <b>${esc(round.code)}</b></div>` +
      `<p class="hint">Type part of your name or your roll number. First come, first in the queue.</p>`, joinUrl());
  }

  function render(){
    document.body.classList.toggle('hands-on', !!round);
    $('huStartBtn').textContent = round ? '↻ New round' : '✋ Start hands-up';
    $('huEndBtn').hidden = !round;
    if (!round){ qrFor = ''; setTimeout(resize, 50); return; }
    $('huBatch').textContent = round.batch;
    $('huCode').textContent = round.code;
    if (qrFor !== round.code){ $('huQR').innerHTML = qrSvg(joinUrl(), 4); qrFor = round.code; setTimeout(resize, 50); }
    $('huErr').textContent = lastErr ? '⚠ ' + lastErr : '';
    $('huCount').textContent = queue.length ? `${queue.length} waiting` : 'No hands yet';
    $('huList').innerHTML = queue.map((h, i) =>
      `<li><span class="hu-pos">${i + 1}</span><span class="hu-name">${esc(h.name)}</span><small>${ago(h.t)}</small>` +
      `<button class="btn small" data-pick="${h.id}" title="Pick">✔</button><button class="btn small" data-rm="${h.id}" title="Remove">✕</button></li>`).join('');
    $('huNextBtn').disabled = !queue.length;
  }

  function init(){
    $('huStartBtn').onclick = start;
    $('huEndBtn').onclick = stop;
    $('huStopBtn').onclick = stop;
    $('huNextBtn').onclick = pickNext;
    $('huQR').onclick = enlarge;
    $('huList').onclick = e => {
      const p = e.target.closest('[data-pick]'), r = e.target.closest('[data-rm]');
      if (p) pick(+p.dataset.pick); else if (r) remove(+r.dataset.rm);
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && round) schedule(100); });
    setInterval(() => { if (round) render(); }, 15000);   // refresh "x s ago"
    render();
    if (CR.connected()) poll();   // resume a round that is still open after a reload
  }

  return { init, start, stop, pickNext, isOpen, enlarge };
})();
