/** ============================================================
 * Smart CRM — CloudflareSync.gs
 *
 * Google Sheet <-> naya Cloudflare app.
 *  1. Pehli baar: Sheet ka saara data app mein copy (menu se, ek baar).
 *  2. Har 5 minute: app ka data Sheet mein (report / backup).
 *     Sirf wahi lines aati hain jo badli hain (poori table dobara nahi padhi
 *     jaati) — Cloudflare ki free limit bachaane ke liye.
 *  3. Sheet mein koi cell badlo: kuch second mein app mein.
 *
 * Setup (ek baar): Project Settings > Script Properties mein
 *   CF_URL      = https://rkgarg-crm.pages.dev   (aapka Cloudflare link)
 *   CF_SYNC_KEY = wahi lamba secret jo Cloudflare mein SYNC_KEY rakha
 * Phir Sheet menu: Smart CRM > Cloudflare sync chalu karo.
 * ============================================================ */

/** Tabs that the app owns, in export order. */
const CF_TABS_ = ['Leads', 'CallLog', 'Users', 'Team', 'CRM Visits', 'LegacyReview', 'LegacyImportBatches', 'LegacyImportRows', 'AuditLog'];
/** Typing in these tabs goes to the app (other tabs are report only). */
const CF_EDITABLE_TABS_ = ['Leads', 'CallLog', 'Users', 'Team', 'CRM Visits', 'LegacyReview'];
/** Date + time columns (shown as dates in the Sheet, sent as ISO to the app). */
const CF_DATETIME_COLS_ = ['LastCallAt', 'NextFollowupAt', 'CreatedAt', 'LastUpdatedAt', 'CallDate', 'UpdatedAt', 'ActualAt', 'ResolvedAt', 'Timestamp'];
/** Date-only column (yyyy-MM-dd in the app). */
const CF_DAY_COLS_ = ['PlannedDate'];

function cfConfig_() {
  const p = PropertiesService.getScriptProperties();
  const url = String(p.getProperty('CF_URL') || '').replace(/\/+$/, '');
  const key = String(p.getProperty('CF_SYNC_KEY') || '');
  if (!/^(https:\/\/|http:\/\/127\.0\.0\.1:)/.test(url) || key.length < 16) {
    throw new Error('Script Properties mein CF_URL aur CF_SYNC_KEY daalein (Project Settings > Script Properties).');
  }
  return { url: url, key: key };
}

function cfCall_(body) {
  const c = cfConfig_();
  body.key = c.key;
  const res = UrlFetchApp.fetch(c.url + '/api/sync', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  let data;
  try { data = JSON.parse(res.getContentText()); } catch (e) { throw new Error('Cloudflare se galat jawab (' + res.getResponseCode() + '). Link check karein.'); }
  if (!data.ok) throw new Error(data.error === 'SYNC_KEY_INVALID' ? 'CF_SYNC_KEY galat hai — Cloudflare ke SYNC_KEY se match karein.' : String(data.error));
  return data.result;
}

/* ---------------- Values: Sheet <-> app ---------------- */

function cfToApp_(header, v) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    if (CF_DAY_COLS_.indexOf(header) !== -1) return Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
    if (header === 'LastKnownDate' || header === 'SourceDate') return Utilities.formatDate(v, 'Asia/Kolkata', 'dd-MMM-yy');
    return v.toISOString();
  }
  return v;
}
function cfToSheet_(header, v) {
  if (v === null || v === undefined) return '';
  if (CF_DATETIME_COLS_.indexOf(header) !== -1 && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d;
  }
  if (CF_DAY_COLS_.indexOf(header) !== -1 && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return new Date(v + 'T00:00:00+05:30');
  }
  if (typeof v === 'string' && /^[=+@]/.test(v)) return "'" + v; // never run text as a formula
  return v;
}
function cfSame_(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const x = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const y = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return x === y || (isNaN(x) && isNaN(y) && String(a) === String(b));
  }
  if (typeof b === 'string' && b.charAt(0) === "'") b = b.slice(1);
  return String(a) === String(b);
}

/* ---------------- 1. Pehli baar: Sheet -> app ---------------- */

/** Menu item. Asks before replacing app data with the Sheet. */
function cfCopySheetToAppMenu() {
  const ui = SpreadsheetApp.getUi();
  const ans = ui.prompt(
    'Sheet ka data app mein copy',
    'Isse app ka SAARA data is Sheet jaisa ho jaayega (app mein jo baad mein hua, wo hat jaayega).\n' +
    'Sirf PEHLI BAAR ya galti theek karne ke liye. Aage badhne ke liye COPY likhein:',
    ui.ButtonSet.OK_CANCEL
  );
  if (ans.getSelectedButton() !== ui.Button.OK || ans.getResponseText().trim().toUpperCase() !== 'COPY') {
    ui.alert('Kuch copy nahi hua.');
    return;
  }
  const report = cfCopySheetToApp_();
  ui.alert('Copy ho gaya', report, ui.ButtonSet.OK);
}

function cfCopySheetToApp_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Doosra sync chal raha hai. 1 minute baad try karein.');
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const lines = [];
    CF_TABS_.forEach(name => {
      const sh = ss.getSheetByName(name);
      cfCall_({ op: 'reset', table: name });
      if (!sh || sh.getLastRow() < 2) { lines.push(name + ': 0'); return; }
      const values = sh.getDataRange().getValues();
      const headers = values[0].map(h => String(h || '').trim());
      let rows = values.slice(1).filter(r => r.some(v => v !== '' && v !== null));
      // Leads typed by hand without an ID get one now (written back to the Sheet).
      if (name === 'Leads') {
        const idCol = headers.indexOf('ID');
        if (idCol !== -1) {
          let changed = false;
          values.slice(1).forEach((r, i) => {
            if (!r[idCol] && r.some(v => v !== '' && v !== null)) { r[idCol] = Utilities.getUuid(); values[i + 1][idCol] = r[idCol]; changed = true; }
          });
          if (changed) sh.getRange(2, idCol + 1, values.length - 1, 1).setValues(values.slice(1).map(r => [r[idCol]]));
          rows = values.slice(1).filter(r => r.some(v => v !== '' && v !== null));
        }
      }
      let inserted = 0;
      const skipped = [];
      for (let i = 0; i < rows.length; i += 200) {
        const part = rows.slice(i, i + 200).map(r => r.map((v, c) => cfToApp_(headers[c], v)));
        const res = cfCall_({ op: 'append', table: name, headers: headers, rows: part });
        inserted += res.inserted;
        skipped.push.apply(skipped, res.skipped);
      }
      lines.push(name + ': ' + inserted + (skipped.length ? '  (chhoda: ' + skipped.slice(0, 10).join(', ') + (skipped.length > 10 ? '…' : '') + ')' : ''));
    });
    cfForgetPulled_();
    const report = lines.join('\n');
    Logger.log(report);
    return report;
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- 2. Har 5 minute: app -> Sheet ---------------- */

function cfPullFromApp(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // a Sheet edit is being sent; next run will catch up
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet(), props = PropertiesService.getScriptProperties();
    const cursor = props.getProperty('CF_SYNC_SEQ');
    if (force === true || !cursor) {
      // Full copy (first time / menu). Position is taken BEFORE copying, so nothing is missed.
      const start = cfCall_({ op: 'cursor' }).seq;
      CF_TABS_.forEach(name => { if (name === 'AuditLog') cfPullAudit_(ss, props, true); else cfPullTab_(ss, name); });
      props.setProperty('CF_SYNC_SEQ', String(start));
      props.deleteProperty('CF_RESEND');
    } else {
      // Only rows changed since last time. Nothing changed = nothing read.
      let seq = Number(cursor), more = true, pages = 0;
      while (more && pages++ < 20) {
        const res = cfCall_({ op: 'changes', afterSeq: seq, limit: 500 });
        Object.keys(res.tabs || {}).forEach(name => cfApplyRows_(ss, name, res.tabs[name]));
        seq = Number(res.lastSeq) || seq; more = res.more === true;
        props.setProperty('CF_SYNC_SEQ', String(seq));
      }
      cfResendRefused_(ss, props);
      cfPullAudit_(ss, props, false);
    }
    props.setProperty('CF_LAST_PULL', new Date().toISOString());
  } finally {
    lock.releaseLock();
  }
}

/** Put changed rows into the Sheet: update in place by ID, add new ones, remove deleted ones. */
function cfApplyRows_(ss, name, data) {
  const headers = data.headers, n = data.rows.length + data.deleted.length;
  if (!n) return;
  const sh = ss.getSheetByName(name);
  if (!sh || n > 150) { cfPullTab_(ss, name); return; } // big change: one full copy of this tab is simpler
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const top = lastRow ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim()) : [];
  if (top.length !== headers.length || top.some((h, i) => h !== headers[i])) { cfPullTab_(ss, name); return; }
  const kc = headers.indexOf(data.key);
  const cur = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  const where = {};
  cur.forEach((r, i) => { const k = String(r[kc]); if (k && where[k] === undefined) where[k] = i; });
  const adds = [];
  data.rows.forEach(r => {
    const vals = r.map((v, i) => cfToSheet_(headers[i], v)), i = where[String(r[kc])];
    if (i === undefined) { adds.push(vals); return; }
    if (!cur[i].every((v, j) => cfSame_(v, vals[j]))) sh.getRange(i + 2, 1, 1, headers.length).setValues([vals]);
  });
  if (adds.length) {
    if (sh.getMaxRows() < lastRow + adds.length) sh.insertRowsAfter(sh.getMaxRows(), lastRow + adds.length - sh.getMaxRows());
    sh.getRange(lastRow + 1, 1, adds.length, headers.length).setValues(adds);
  }
  data.deleted.map(k => where[String(k)]).filter(i => i !== undefined).sort((a, b) => b - a).forEach(i => sh.deleteRow(i + 2));
}

/** Sheet edits the app refused: show the app's value again in those rows. */
function cfResendRefused_(ss, props) {
  let list = {};
  try { list = JSON.parse(props.getProperty('CF_RESEND') || '{}'); } catch (err) { list = {}; }
  Object.keys(list).forEach(name => {
    if (list[name] === 'ALL') cfPullTab_(ss, name);
    else if (list[name].length) cfApplyRows_(ss, name, cfCall_({ op: 'rows', table: name, keys: list[name] }));
  });
  props.deleteProperty('CF_RESEND');
}
function cfMarkResend_(name, keys, all) {
  const props = PropertiesService.getScriptProperties();
  let list = {};
  try { list = JSON.parse(props.getProperty('CF_RESEND') || '{}'); } catch (err) { list = {}; }
  if (all || list[name] === 'ALL') list[name] = 'ALL';
  else list[name] = (list[name] || []).concat(keys).filter((k, i, a) => k && a.indexOf(k) === i).slice(0, 400);
  props.setProperty('CF_RESEND', JSON.stringify(list));
}

/** Whole tab from the app -> Sheet (writes only when something changed). */
function cfPullTab_(ss, name) {
  let headers = null, rows = [], offset = 0, total = 1;
  while (offset < total) {
    const res = cfCall_({ op: 'export', table: name, offset: offset, limit: 1000 });
    headers = res.headers; total = res.total;
    rows = rows.concat(res.rows);
    offset += res.rows.length;
    if (!res.rows.length) break;
  }
  if (!headers) return;
  const matrix = [headers].concat(rows.map(r => r.map((v, i) => cfToSheet_(headers[i], v))));
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  // Write only when something changed (keeps the Sheet calm for people reading it).
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow === matrix.length && lastCol === headers.length) {
    const cur = sh.getRange(1, 1, lastRow, lastCol).getValues();
    const same = cur.every((r, i) => r.every((v, j) => cfSame_(v, matrix[i][j])));
    if (same) return;
  }
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  if (sh.getMaxRows() < matrix.length) sh.insertRowsAfter(sh.getMaxRows(), matrix.length - sh.getMaxRows());
  sh.getRange(1, 1, matrix.length, headers.length).setValues(matrix);
  if (lastRow > matrix.length) sh.getRange(matrix.length + 1, 1, lastRow - matrix.length, Math.max(lastCol, headers.length)).clearContent();
  if (lastCol > headers.length) sh.getRange(1, headers.length + 1, Math.max(lastRow, matrix.length), lastCol - headers.length).clearContent();
  sh.setFrozenRows(1);
}

/** AuditLog only grows: add just the new lines (full rebuild the first time or when forced). */
function cfPullAudit_(ss, props, rebuildAll) {
  let sh = ss.getSheetByName('AuditLog');
  let seq = Number(props.getProperty('CF_AUDIT_SEQ') || 0);
  const rebuild = rebuildAll || !sh || !seq;
  if (rebuild) seq = 0;
  let headers = null, rows = [], more = true, pages = 0;
  while (more && pages++ < 200) {
    const res = cfCall_({ op: 'export', table: 'AuditLog', afterSeq: seq, limit: 1000 });
    headers = res.headers; rows = rows.concat(res.rows); seq = Number(res.lastSeq) || seq; more = res.more === true;
  }
  if (!headers) return;
  const data = rows.map(r => r.map((v, i) => cfToSheet_(headers[i], v)));
  if (!sh) sh = ss.insertSheet('AuditLog');
  if (rebuild) {
    sh.clearContents();
    const matrix = [headers].concat(data);
    if (sh.getMaxRows() < matrix.length) sh.insertRowsAfter(sh.getMaxRows(), matrix.length - sh.getMaxRows());
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    sh.getRange(1, 1, matrix.length, headers.length).setValues(matrix);
    sh.setFrozenRows(1);
  } else if (data.length) {
    const start = sh.getLastRow() + 1;
    if (sh.getMaxRows() < start + data.length - 1) sh.insertRowsAfter(sh.getMaxRows(), start + data.length - 1 - sh.getMaxRows());
    sh.getRange(start, 1, data.length, headers.length).setValues(data);
  }
  props.setProperty('CF_AUDIT_SEQ', String(seq));
}

/** Forget what was sent, so the next pull re-sends every tab (after a fresh copy). */
function cfForgetPulled_() {
  const props = PropertiesService.getScriptProperties();
  CF_TABS_.forEach(name => props.deleteProperty('CF_VER_' + name));
  ['CF_SYNC_SEQ', 'CF_AUDIT_SEQ', 'CF_RESEND'].forEach(k => props.deleteProperty(k));
}

/* ---------------- 3. Sheet mein badlav -> app ---------------- */

/** Installable "On edit" trigger (set up by cfSetupSync). */
function cfOnSheetEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName();
  if (CF_EDITABLE_TABS_.indexOf(name) === -1) return;
  const first = e.range.getRow(), count = e.range.getNumRows();
  if (first + count - 1 < 2) return; // header row only
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { SpreadsheetApp.getActiveSpreadsheet().toast('App busy hai, ye badlav 5 minute mein dobara bhejna padega.', 'Smart CRM', 8); return; }
  try {
    const lastCol = sh.getLastColumn();
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
    const startRow = Math.max(2, first), rows = sh.getRange(startRow, 1, first + count - startRow, lastCol).getValues();
    const user = (Session.getActiveUser().getEmail() || 'sheet').split('@')[0];
    const messages = [], refused = [];
    rows.slice(0, 50).forEach((row, i) => {
      if (!row.some(v => v !== '' && v !== null)) return;
      const res = cfCall_({ op: 'row', table: name, headers: headers, row: row.map((v, c) => cfToApp_(headers[c], v)), user: user });
      const keyName = name === 'Users' ? 'Username' : name === 'Team' ? 'Name' : 'ID';
      const keyCol = headers.indexOf(keyName);
      if (res.created && res.key && keyCol !== -1 && !row[keyCol]) sh.getRange(startRow + i, keyCol + 1).setValue(res.key);
      if (!res.ok && !res.waiting) { messages.push('Row ' + (startRow + i) + ': ' + res.message); if (keyCol !== -1 && row[keyCol]) refused.push(String(row[keyCol])); }
      const noteCell = sh.getRange(startRow + i, e.range.getColumn());
      noteCell.setNote(res.ok || res.waiting ? '' : 'App mein NAHI gaya: ' + res.message);
    });
    // Refused change: next pull puts the app's value back in those rows.
    if (refused.length || count > 50) cfMarkResend_(name, refused, count > 50);
    if (count > 50) messages.push('Ek baar mein 50 rows tak hi bhejte hain. Baaki rows 5 min wale sync mein theek ho jaayengi.');
    if (messages.length) SpreadsheetApp.getActiveSpreadsheet().toast(messages.join('\n'), 'Smart CRM', 10);
  } catch (err) {
    SpreadsheetApp.getActiveSpreadsheet().toast('App tak nahi pahuncha: ' + err.message, 'Smart CRM', 10);
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Setup ---------------- */

/** Menu item: checks the connection and creates the two triggers. */
function cfSetupSync() {
  const ui = SpreadsheetApp.getUi();
  const status = cfCall_({ op: 'status' }); // throws a clear message if URL / key is wrong
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['cfPullFromApp', 'cfOnSheetEdit'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cfPullFromApp').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('cfOnSheetEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  ui.alert('Cloudflare sync chalu ✓',
    'App se juda hua hai. App mein abhi: ' + status.counts.Leads + ' customers, ' + status.counts.CallLog + ' calls.\n' +
    'Har 5 minute mein Sheet update hogi, aur Sheet ke badlav app mein jaayenge.', ui.ButtonSet.OK);
}

/** Menu item: update the Sheet from the app right now. */
function cfPullNowMenu() {
  cfPullFromApp(true); // full refresh: every tab, even if nothing changed
  SpreadsheetApp.getActiveSpreadsheet().toast('Sheet app ke data se update ho gayi.', 'Smart CRM', 5);
}
