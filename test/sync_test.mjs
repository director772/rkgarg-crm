// Runs CloudflareSync.gs (Apps Script) against the local API over real HTTP.
import fs from 'node:fs'; import vm from 'node:vm'; import { execFileSync } from 'node:child_process'; import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
const port = 8799, env = { SYNC_KEY: 'test-sync-key-1234567890' };
const child = spawn(process.execPath, ['--no-warnings', new URL('./server.js', import.meta.url).pathname, 'run', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(ok => child.stdout.once('data', ok));
const srv = { close: () => child.kill() };
let ok = 0, bad = 0; const check = (c, m) => { if (c) { ok++; console.log('ok -', m); } else { bad++; console.log('FAIL -', m); } };
// ---- tiny Google Sheet mock ----
class Range { constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sh.rows[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); } o.push(row); } return o; }
  setValues(v) { v.forEach((row, i) => { const R = this.r - 1 + i; while (this.sh.rows.length <= R) this.sh.rows.push([]); row.forEach((x, j) => this.sh.rows[R][this.c - 1 + j] = (typeof x === 'string' && x[0] === "'") ? x.slice(1) : x); }); return this; }
  setValue(x) { return this.setValues([[x]]); } clearContent() { return this.setValues(Array.from({ length: this.nr }, () => Array(this.nc).fill(''))); }
  getRow() { return this.r; } getColumn() { return this.c; } getNumRows() { return this.nr; } getSheet() { return this.sh; } setNote(n) { this.sh.notes[this.r + ':' + this.c] = n; } }
class Sheet { constructor(name, rows) { this.name = name; this.rows = rows; this.notes = {}; }
  getName() { return this.name; } getLastRow() { let n = this.rows.length; while (n && !this.rows[n - 1].some(v => v !== '' && v != null)) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => { let n = r.length; while (n && (r[n - 1] === '' || r[n - 1] == null)) n--; return n; })); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); } getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  getMaxColumns() { return 40; } getMaxRows() { return 100000; } insertColumnsAfter() {} insertRowsAfter() {} setFrozenRows() {} }
const D = s => new Date(s);
const sheets = {
  Users: new Sheet('Users', [['Username', 'PasswordHash', 'Salt', 'DisplayName', 'Role', 'TeamMemberName', 'Active'],
    ['owner', crypto.createHash('sha256').update('pass1234::s1').digest('hex'), 's1', 'Owner', 'Owner', '', true],
    ['bhawna', crypto.createHash('sha256').update('pass1234::s2').digest('hex'), 's2', 'Bhawna', 'CRM', 'Bhawna', true]]),
  Team: new Sheet('Team', [['Name', 'Active'], ['Bhawna', true], ['Dimpy', true]]),
  Leads: new Sheet('Leads', [['ID', 'Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Status', 'Disposition', 'Score', 'LastCallAt', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedAt', 'CreatedBy', 'LastUpdatedAt', 'LastUpdatedBy', 'RowVersion'],
    ['L1', 'Rudransh Fashion', 6391288408, 'Baliya up', 'Meta Ad', 'Jeans', 'Bhawna', 'callback', 'Not Picked', 8, D('2026-10-28T08:16:00Z'), 'Call', D('2026-10-30T06:11:00Z'), 'visit within 2-3 days', D('2026-10-20T05:00:00Z'), 'bhawna', '', '', 4],
    ['', 'Typed By Hand', 9988776655, 'Kanpur', 'Walk-in', '', 'Dimpy', 'fresh', 'Yet To Call', 8, '', 'Call', '', '', '', '', '', '', 1]]),
  CallLog: new Sheet('CallLog', [['ID', 'LeadID', 'CallDate', 'Response', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedBy', 'CreatedAt', 'CRM', 'UpdatedAt', 'UpdatedBy'],
    ['C1', 'L1', D('2026-10-28T08:16:00Z'), 'Not Picked', 'Call', D('2026-10-30T06:11:00Z'), '', 'bhawna', D('2026-10-28T08:16:00Z'), 'Bhawna', '', '']]),
  'CRM Visits': new Sheet('CRM Visits', [['ID', 'LeadID', 'CRM', 'PlannedDate', 'Status', 'ActualAt', 'Note', 'Version', 'UpdatedAt', 'UpdatedBy'], ['V1', 'L1', 'Bhawna', D('2026-11-04T18:30:00Z'), 'Planned', '', 'aayega', 1, '', '']]),
  LegacyReview: new Sheet('LegacyReview', [['ID', 'Name', 'Mobile', 'RowsFound', 'LastKnownDisposition', 'LastKnownDate', 'Details', 'Status', 'ResolvedBy', 'ResolvedAt', 'ImportBatchID', 'ImportSource'], ['LEG-1', 'Sonu', '7456997801', 1, 'x', '27-Oct-26', '[]', 'pending', '', '', 'B1', 'LegacyImportRows']]),
  AuditLog: new Sheet('AuditLog', [['Timestamp', 'User', 'Action', 'EntityType', 'EntityID', 'Details'], [D('2026-10-28T08:00:00Z'), 'owner', 'LOGIN', 'User', 'owner', '']])
};
const toasts = [];
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n, [])), toast: m => toasts.push(m), getActive() { return ss; } };
const props = { CF_URL: 'http://127.0.0.1:' + port, CF_SYNC_KEY: env.SYNC_KEY };
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, getActive: () => ss, getUi: () => ({ alert() {}, prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => 'COPY' }), Button: { OK: 'OK' }, ButtonSet: {} }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => props[k] = v }) },
  UrlFetchApp: { fetch: (url, o) => { const out = execFileSync('curl', ['-s', '-X', 'POST', '-H', 'content-type: application/json', '--data-binary', '@-', '-w', '\n%{http_code}', url], { input: o.payload }).toString(); const i = out.lastIndexOf('\n'); return { getContentText: () => out.slice(0, i), getResponseCode: () => Number(out.slice(i + 1)) }; } },
  Utilities: { getUuid: () => crypto.randomUUID(), formatDate: (d, tz, f) => { const x = new Date(d.getTime() + 19800000).toISOString(); if (f === 'yyyy-MM-dd') return x.slice(0, 10); return x; } },
  Session: { getActiveUser: () => ({ getEmail: () => 'anshul@rkgargjeans.com' }) },
  ScriptApp: { getProjectTriggers: () => [] }, Logger: { log() {} }, console, Date, JSON, Math, String, Number, Array, Object, isNaN, Error, RegExp
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../apps-script/CloudflareSync.gs', import.meta.url), 'utf8') + ';this.F={cfCopySheetToApp_,cfPullFromApp,cfOnSheetEdit,cfCall_};', ctx);
const F = ctx.F;
// 1) first-time copy
const rep = F.cfCopySheetToApp_();
check(/Leads: 2/.test(rep) && /Users: 2/.test(rep) && /CallLog: 1/.test(rep), 'first copy: ' + rep.replace(/\n/g, ' | '));
check(sheets.Leads.rows[2][0] && sheets.Leads.rows[2][0].length === 36, 'hand-typed lead got an ID written back');
const app = async q => (await fetch(`http://127.0.0.1:${port}/__sql?q=` + encodeURIComponent(q))).json();
check((await app("SELECT Mobile FROM Leads WHERE ID='L1'")).Mobile === '6391288408', 'mobile stored as text');
check((await app("SELECT PlannedDate FROM Visits WHERE ID='V1'")).PlannedDate === '2026-11-05', 'visit date kept as India date (2026-11-05)');
check((await app("SELECT NextFollowupAt FROM Leads WHERE ID='L1'")).NextFollowupAt === '2026-10-30T06:11:00.000Z', 'follow-up time exact');
// login with old password in app
const lg = await (await fetch(props.CF_URL + '/api/login', { method: 'POST', body: JSON.stringify({ args: ['bhawna', 'pass1234'] }) })).json();
check(lg.ok, 'old Sheet password works in the new app');
// 2) change in app -> pull to Sheet
const tok = lg.result.token;
const save = await (await fetch(props.CF_URL + '/api/saveCallOutcome', { method: 'POST', body: JSON.stringify({ token: tok, args: [{ leadId: 'L1', knownRowVersion: 4, response: 'Interested', nextActionType: 'WhatsApp', nextFollowupAt: new Date(Date.now() + 86400000).toISOString(), note: 'maal dekhega' }, 'req-sync-0001'] }) })).json();
check(save.ok && save.result.success, 'call saved in app');
F.cfPullFromApp();
const lh = sheets.Leads.rows[0];
const l1 = sheets.Leads.rows.find(r => r[0] === 'L1');
check(l1[lh.indexOf('Disposition')] === 'Interested' && l1[lh.indexOf('Note')] === 'maal dekhega', 'Sheet updated from app (pull)');
check(l1[lh.indexOf('NextFollowupAt')] instanceof Date, 'dates written as real dates in Sheet');
check(sheets.CallLog.getLastRow() === 3, 'CallLog in Sheet has new call row');
const before = JSON.stringify(sheets.Leads.rows); F.cfPullFromApp();
check(JSON.stringify(sheets.Leads.rows) === before, 'second pull with no change keeps Sheet same');
// 3) Sheet edit -> app
const r = sheets.Leads.rows.indexOf(l1) + 1;
l1[lh.indexOf('City')] = 'Ballia';
F.cfOnSheetEdit({ range: sheets.Leads.getRange(r, lh.indexOf('City') + 1) });
check((await app("SELECT City, RowVersion FROM Leads WHERE ID='L1'")).City === 'Ballia', 'Sheet edit reached the app');
// new row typed in Sheet
sheets.Leads.rows.push(lh.map(h => ({ Name: 'Naya Grahak', Mobile: 9000011111, CRM: 'Bhawna', City: 'Delhi' }[h] ?? '')));
const nr = sheets.Leads.rows.length;
F.cfOnSheetEdit({ range: sheets.Leads.getRange(nr, 2) });
const newId = sheets.Leads.rows[nr - 1][0];
check(newId && (await app(`SELECT Name FROM Leads WHERE ID='${newId}'`)).Name === 'Naya Grahak', 'new Sheet row -> new customer, ID written back');
// bad edit -> note on cell, app unchanged
l1[lh.indexOf('Mobile')] = 9988776655; // belongs to the hand-typed lead
F.cfOnSheetEdit({ range: sheets.Leads.getRange(r, lh.indexOf('Mobile') + 1) });
check((await app("SELECT Mobile FROM Leads WHERE ID='L1'")).Mobile === '6391288408' && /NAHI gaya/.test(sheets.Leads.notes[r + ':' + (lh.indexOf('Mobile') + 1)] || ''), 'duplicate mobile in Sheet: refused + note on the cell');
F.cfPullFromApp();
check(String(sheets.Leads.rows.find(x => x[0] === 'L1')[lh.indexOf('Mobile')]) === '6391288408', 'next pull puts the correct mobile back in the Sheet');
// Team edit
sheets.Team.rows[2][1] = false; F.cfOnSheetEdit({ range: sheets.Team.getRange(3, 2) });
check((await app("SELECT Active FROM Team WHERE Name='Dimpy'")).Active === 0, 'Team Active FALSE in Sheet -> app');
console.log(`\n${ok} ok, ${bad} failed`);
srv.close(); process.exit(bad ? 1 : 0);
