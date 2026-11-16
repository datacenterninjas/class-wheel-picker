/**
 * Class Wheel: participation credits backend (Google Apps Script)
 *
 * One-time setup
 *  1. Create a Google Sheet. Open Extensions → Apps Script, delete the sample code
 *     and paste this whole file as Code.gs. Save.
 *  2. Pick `setup` in the function dropdown and press Run. Approve the permissions.
 *     The execution log shows your secret key. (Run `showKey` any time to see it again.)
 *  3. Deploy → New deployment → type "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     Copy the web app URL (it ends in /exec).
 *  4. In the wheel, open "Google Sheet connection", paste the URL and the key, press Connect.
 *  5. Put student names in the Roster tab: column A = batch (e.g. "Batch 1"), column B = name.
 *
 * After editing this code later: Deploy → Manage deployments → edit (pencil) →
 * Version: New version → Deploy. The URL stays the same.
 *
 * Tabs
 *  Roster  Batch | Name | Roll (optional; students can type it on the hands-up page)
 *  Log     one row per credit, never edited (undo adds a minus row)
 *  Totals  live QUERY over Log: credits per student
 *  Hands   hands-up queue: one row each time a student raises a hand from the QR page
 */

const TZ = 'Asia/Kolkata';
const ROSTER = 'Roster', LOG = 'Log', TOTALS = 'Totals', HANDS = 'Hands';
const LOG_HEADERS = ['Timestamp', 'Event ID', 'Batch', 'Name', 'Points', 'Source', 'Class date', 'Note'];
const HANDS_HEADERS = ['Time', 'Round', 'Batch', 'Name', 'Device', 'Status', 'Typed'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
const MAX_POINTS = 10;      // largest single award (or undo) the Sheet accepts
const MAX_EVENTS = 500;     // per request

/* ---------- setup (run from the editor) ---------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Sheet (Extensions → Apps Script) and run setup again.');
  ss.setSpreadsheetTimeZone(TZ);

  const roster = ss.getSheetByName(ROSTER) || ss.insertSheet(ROSTER);
  if (roster.getLastRow() === 0) { roster.appendRow(['Batch', 'Name', 'Roll']); roster.setFrozenRows(1); }
  if (!roster.getRange(1, 3).getValue()) roster.getRange(1, 3).setValue('Roll');
  roster.getRange('C:C').setNumberFormat('@');  // roll numbers as text (keeps leading zeros)

  const hands = ss.getSheetByName(HANDS) || ss.insertSheet(HANDS);
  if (hands.getLastRow() === 0) { hands.appendRow(HANDS_HEADERS); hands.setFrozenRows(1); }

  const log = ss.getSheetByName(LOG) || ss.insertSheet(LOG);
  if (log.getLastRow() === 0) { log.appendRow(LOG_HEADERS); log.setFrozenRows(1); }
  log.getRange('G:G').setNumberFormat('@');   // keep class dates as plain text (yyyy-mm-dd)

  const totals = ss.getSheetByName(TOTALS) || ss.insertSheet(TOTALS);
  totals.getRange('A1').setFormula(
    '=QUERY(Log!A:H,"select C, D, sum(E) where C is not null group by C, D ' +
    'order by C, sum(E) desc label sum(E) \'Credits\'",1)');

  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());
  let key = props.getProperty('KEY');
  if (!key) { key = newKeyValue_(); props.setProperty('KEY', key); }
  Logger.log('Setup done. Your secret key is: ' + key);
}

function showKey() {
  Logger.log('Secret key: ' + PropertiesService.getScriptProperties().getProperty('KEY'));
}

/** Run this if the key leaks. Every device then needs the new key. */
function resetKey() {
  const key = newKeyValue_();
  PropertiesService.getScriptProperties().setProperty('KEY', key);
  Logger.log('New secret key: ' + key);
}

function newKeyValue_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

/* ---------- web app entry points ---------- */

function doGet(e) {
  return respond_(() => {
    const p = (e && e.parameter) || {}, action = p.action || 'state';
    // student actions: need the round code shown on the QR, not the key.
    // (The parameter is "code", not "c": Apps Script reserves "c" and "sid".)
    if (action === 'round') return publicRound_(p.code);
    if (action === 'mystatus') return myStatus_(p.code, p.device);
    auth_(p.key);
    if (action === 'state') return state_(String(p.date || ''));
    if (action === 'queue') return queue_();
    throw new Error('Unknown action');
  });
}

function doPost(e) {
  return respond_(() => {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'raise') return raise_(body);
    if (body.action === 'lower') return lower_(body.code, body.device);
    auth_(body.key);
    if (body.action === 'award') return award_(body.events || [], String(body.date || ''));
    if (body.action === 'setRoster') return setRoster_(body.batch, body.names);
    if (body.action === 'openRound') return openRound_(body.batch);
    if (body.action === 'closeRound') return closeRound_();
    if (body.action === 'handDone') return handDone_(body.id, body.status);
    throw new Error('Unknown action');
  });
}

function respond_(fn) {
  let out;
  try { out = Object.assign({ ok: true }, fn()); }
  catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function auth_(key) {
  const real = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!real) throw new Error('Run setup in the Apps Script editor first');
  if (String(key || '') !== real) throw new Error('Wrong key');
}

/* ---------- actions ---------- */

/** Roster + credit totals. `date` (yyyy-mm-dd, the device's today) fills the "today" counts. */
function state_(date) {
  const roster = {};
  rows_(sheet_(ROSTER), 2).forEach(r => {
    const batch = String(r[0]).trim(), name = String(r[1]).trim();
    if (!batch || !name) return;
    const list = roster[batch] || (roster[batch] = []);
    if (list.indexOf(name) < 0) list.push(name);
  });
  return { roster: roster, totals: totals_(rows_(sheet_(LOG), 8), date), sheetUrl: book_().getUrl() };
}

/** Append credit events. Events already in the Log (same Event ID) are skipped, so resending is safe. */
function award_(events, date) {
  if (!Array.isArray(events)) throw new Error('events must be a list');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(LOG), rows = rows_(sh, 8);
    const seen = new Set(rows.map(r => String(r[1])));
    const add = [], rejected = [];
    events.slice(0, MAX_EVENTS).forEach(ev => {
      const id = String((ev && ev.id) || '').slice(0, 64);
      const batch = String(ev && ev.batch || '').trim().slice(0, 60);
      const name = String(ev && ev.name || '').trim().slice(0, 120);
      const pts = Number(ev && ev.points);
      if (!id || !batch || !name || !isFinite(pts) || Math.abs(pts) > MAX_POINTS) { rejected.push(id); return; }
      if (seen.has(id)) return;
      seen.add(id);
      const t = new Date(ev.t);
      add.push([isNaN(t.getTime()) ? new Date() : t, id, safe_(batch), safe_(name), pts,
        String(ev.source || '').slice(0, 20), String(ev.date || '').slice(0, 10), safe_(String(ev.note || '').slice(0, 200))]);
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 8).setValues(add);
    return {
      accepted: events.slice(0, MAX_EVENTS).map(ev => String((ev && ev.id) || '')),
      rejected: rejected, added: add.length,
      totals: totals_(rows.concat(add), date)
    };
  } finally {
    lock.releaseLock();
  }
}

/** Replace one batch's names in the Roster tab (other batches are kept). */
function setRoster_(batch, names) {
  const label = String(batch || '').trim();
  if (!label) throw new Error('batch is required');
  if (!Array.isArray(names)) throw new Error('names must be a list');
  const clean = [];
  names.forEach(n => { n = String(n || '').replace(/\s+/g, ' ').trim(); if (n && clean.indexOf(n) < 0) clean.push(n); });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(ROSTER), rows = rows_(sh, 3), same = r => String(r[0]).trim().toLowerCase() === label.toLowerCase();
    const roll = {};   // keep roll numbers for names that stay
    rows.filter(same).forEach(r => { roll[String(r[1]).trim()] = r[2]; });
    const all = rows.filter(r => !same(r)).concat(clean.map(n => [safe_(label), safe_(n), roll[n] || '']));
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
    if (all.length) sh.getRange(2, 1, all.length, 3).setValues(all);
    return { count: clean.length };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- hands-up (QR) ---------- */
// The teacher opens a round for one batch and gets a short code. The QR on the wheel
// carries that code. Students type part of their name or their roll number; the first
// match joins the queue. One waiting entry per name and per phone in a round.

function round_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ROUND') || 'null'); }
  catch (e) { return null; }
}
function saveRound_(r) { PropertiesService.getScriptProperties().setProperty('ROUND', JSON.stringify(r)); }

/** Current round if open and the code matches, else null. */
function openRoundFor_(c) {
  const r = round_();
  return r && r.open && String(c || '').trim().toUpperCase() === r.code ? r : null;
}

function openRound_(batch) {
  const label = String(batch || '').trim();
  if (!label) throw new Error('batch is required');
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    closeWaiting_();
    const r = { code: code, batch: label, open: true, t: Date.now() };
    saveRound_(r);
    return { round: r, queue: [] };
  } finally { lock.releaseLock(); }
}

function closeRound_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const r = round_();
    if (r) { r.open = false; saveRound_(r); }
    closeWaiting_();
    return { round: r };
  } finally { lock.releaseLock(); }
}

/** Mark every still-waiting hand from earlier rounds as closed. */
function closeWaiting_() {
  const sh = sheet_(HANDS);
  handRows_(sh, null).forEach(h => { if (h.status === 'waiting') sh.getRange(h.id, 6).setValue('closed'); });
}

function queue_() {
  const r = round_();
  if (!r || !r.open) return { round: r, queue: [] };
  const queue = handRows_(sheet_(HANDS), r.code).filter(h => h.status === 'waiting')
    .map(h => ({ id: h.id, name: h.name, t: h.t }));
  return { round: r, queue: queue };
}

function handDone_(id, status) {
  id = Number(id);
  const sh = sheet_(HANDS);
  if (!(id >= 2 && id <= sh.getLastRow())) throw new Error('No such hand');
  sh.getRange(id, 6).setValue(status === 'picked' ? 'picked' : 'removed');
  return { id: id };
}

function publicRound_(c) {
  const r = openRoundFor_(c);
  return r ? { open: true, batch: r.batch, code: r.code } : { open: false };
}

function raise_(b) {
  const r = openRoundFor_(b.code);
  if (!r) return { status: 'closed' };
  const device = String(b.device || '').slice(0, 64);
  if (!device) throw new Error('device is required');
  const q = String(b.q || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  const list = rows_(sheet_(ROSTER), 3)
    .filter(x => String(x[0]).trim().toLowerCase() === r.batch.toLowerCase() && String(x[1]).trim())
    .map(x => ({ name: String(x[1]).trim(), roll: String(x[2]).trim().toLowerCase() }));
  let match = null;
  if (b.name) {
    match = list.find(x => x.name === String(b.name)) || null;
    if (!match) return { status: 'notfound' };
  } else {
    if (q.length < 2) return { status: 'short' };
    const ql = q.toLowerCase();
    const byRoll = list.filter(x => x.roll && x.roll === ql);
    if (byRoll.length === 1) match = byRoll[0];
    else {
      const toks = ql.split(' ');
      const hits = list.filter(x => toks.every(t => x.name.toLowerCase().indexOf(t) >= 0));
      if (!hits.length) return { status: 'notfound' };
      if (hits.length > 1) return hits.length <= 6 ? { status: 'choose', options: hits.map(x => x.name) } : { status: 'toomany', count: hits.length };
      match = hits[0];
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(HANDS), rows = handRows_(sh, r.code), waiting = rows.filter(h => h.status === 'waiting');
    const mine = waiting.find(h => h.device === device);
    if (mine) return mine.name === match.name
      ? { status: 'queued', name: mine.name, position: waiting.indexOf(mine) + 1 }
      : { status: 'device', name: mine.name };
    const same = waiting.find(h => h.name === match.name);
    if (same) return { status: 'queued', name: same.name, position: waiting.indexOf(same) + 1, already: true };
    sh.appendRow([new Date(), r.code, safe_(r.batch), safe_(match.name), device, 'waiting', safe_(q)]);
    return { status: 'queued', name: match.name, position: waiting.length + 1 };
  } finally { lock.releaseLock(); }
}

function lower_(c, device) {
  const r = openRoundFor_(c);
  if (!r) return { status: 'closed' };
  const sh = sheet_(HANDS);
  handRows_(sh, r.code).forEach(h => { if (h.status === 'waiting' && h.device === String(device || '')) sh.getRange(h.id, 6).setValue('lowered'); });
  return { status: 'lowered' };
}

/** A student's latest hand in the current round: waiting (with position), picked, removed, lowered or closed. */
function myStatus_(c, device) {
  const r = round_();
  if (!r || String(c || '').trim().toUpperCase() !== r.code) return { status: 'closed' };
  const rows = handRows_(sheet_(HANDS), r.code), waiting = rows.filter(h => h.status === 'waiting');
  const mine = rows.filter(h => h.device === String(device || '')).pop();
  if (!mine) return { status: r.open ? 'none' : 'closed' };
  if (mine.status === 'waiting') return { status: 'waiting', name: mine.name, position: waiting.indexOf(mine) + 1 };
  return { status: mine.status, name: mine.name };
}

/** Hands rows (optionally one round) with their sheet row number as id. */
function handRows_(sh, code) {
  return rows_(sh, 7).map((x, i) => ({
    id: i + 2, t: x[0] instanceof Date ? x[0].getTime() : 0, round: String(x[1]), batch: String(x[2]),
    name: String(x[3]).replace(/^'/, '').trim(), device: String(x[4]), status: String(x[5])
  })).filter(h => !code || h.round === code);
}

/* ---------- helpers ---------- */

/** { batch: { name: { total, today, n } } }  n = times marked (undo subtracts one) */
function totals_(rows, date) {
  const out = {};
  rows.forEach(r => {
    const batch = String(r[2]).replace(/^'/, '').trim(), name = String(r[3]).replace(/^'/, '').trim();
    if (!batch || !name) return;
    const pts = Number(r[4]) || 0;
    const d = r[6] instanceof Date ? Utilities.formatDate(r[6], TZ, 'yyyy-MM-dd') : String(r[6]).trim();
    const b = out[batch] || (out[batch] = {});
    const o = b[name] || (b[name] = { total: 0, today: 0, n: 0 });
    o.total += pts;
    if (d === date) o.today += pts;
    o.n += String(r[5]) === 'undo' ? -1 : 1;
  });
  return out;
}

function book_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const book = book_();
  let sh = book.getSheetByName(name);
  if (!sh && name === HANDS) { sh = book.insertSheet(HANDS); sh.appendRow(HANDS_HEADERS); sh.setFrozenRows(1); }
  if (!sh) throw new Error('Sheet tab "' + name + '" is missing. Run setup again.');
  return sh;
}

function rows_(sh, width) {
  const n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, width).getValues();
}

/** Stop text that starts with = + - @ from being read as a formula. */
function safe_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
