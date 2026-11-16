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
 *  Roster  Batch | Name
 *  Log     one row per credit, never edited (undo adds a minus row)
 *  Totals  live QUERY over Log: credits per student
 */

const TZ = 'Asia/Kolkata';
const ROSTER = 'Roster', LOG = 'Log', TOTALS = 'Totals';
const LOG_HEADERS = ['Timestamp', 'Event ID', 'Batch', 'Name', 'Points', 'Source', 'Class date', 'Note'];
const MAX_POINTS = 10;      // largest single award (or undo) the Sheet accepts
const MAX_EVENTS = 500;     // per request

/* ---------- setup (run from the editor) ---------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Sheet (Extensions → Apps Script) and run setup again.');
  ss.setSpreadsheetTimeZone(TZ);

  const roster = ss.getSheetByName(ROSTER) || ss.insertSheet(ROSTER);
  if (roster.getLastRow() === 0) { roster.appendRow(['Batch', 'Name']); roster.setFrozenRows(1); }

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
    const p = (e && e.parameter) || {};
    auth_(p.key);
    if ((p.action || 'state') !== 'state') throw new Error('Unknown action');
    return state_(String(p.date || ''));
  });
}

function doPost(e) {
  return respond_(() => {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    auth_(body.key);
    if (body.action === 'award') return award_(body.events || [], String(body.date || ''));
    if (body.action === 'setRoster') return setRoster_(body.batch, body.names);
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
    const sh = sheet_(ROSTER);
    const keep = rows_(sh, 2).filter(r => String(r[0]).trim().toLowerCase() !== label.toLowerCase());
    const all = keep.concat(clean.map(n => [safe_(label), safe_(n)]));
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
    if (all.length) sh.getRange(2, 1, all.length, 2).setValues(all);
    return { count: clean.length };
  } finally {
    lock.releaseLock();
  }
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
  const sh = book_().getSheetByName(name);
  if (!sh) throw new Error('Sheet tab "' + name + '" is missing. Run setup again.');
  return sh;
}

function rows_(sh, width) {
  const n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, width).getValues();
}

/** Stop text that starts with = + - @ from being read as a formula. */
function safe_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
