// Smart CRM — Google Sheet <-> App sync (called only by the Apps Script
// sync file, protected by the secret SYNC_KEY).
//  - reset/append : first-time copy of the Sheet into the app
//  - export       : app data -> Sheet (every 5 minutes)
//  - row          : one row typed in the Sheet -> app (within seconds)
import { all, first, stmt, insertStmt, updateStmt, auditStmt, isUniqueFailure, q } from './db.js';
import { fail, uuid, normalizeMobile, isValidMobile } from './util.js';
import { activeTeam } from './auth.js';

/** Sheet tab name -> table + key column + column types. */
export const TABLES = {
  Leads: { table: 'Leads', key: 'ID', ints: ['Score', 'RowVersion'],
    cols: ['ID', 'Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Status', 'Disposition', 'Score', 'LastCallAt', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedAt', 'CreatedBy', 'LastUpdatedAt', 'LastUpdatedBy', 'RowVersion'] },
  CallLog: { table: 'CallLog', key: 'ID', ints: [],
    cols: ['ID', 'LeadID', 'CallDate', 'Response', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedBy', 'CreatedAt', 'CRM', 'UpdatedAt', 'UpdatedBy'] },
  Users: { table: 'Users', key: 'Username', ints: [], bools: ['Active'],
    cols: ['Username', 'PasswordHash', 'Salt', 'DisplayName', 'Role', 'TeamMemberName', 'Active'] },
  Team: { table: 'Team', key: 'Name', ints: [], bools: ['Active'], cols: ['Name', 'Active'] },
  'CRM Visits': { table: 'Visits', key: 'ID', ints: ['Version'],
    cols: ['ID', 'LeadID', 'CRM', 'PlannedDate', 'Status', 'ActualAt', 'Note', 'Version', 'UpdatedAt', 'UpdatedBy'] },
  LegacyReview: { table: 'LegacyReview', key: 'ID', ints: ['RowsFound'],
    cols: ['ID', 'Name', 'Mobile', 'RowsFound', 'LastKnownDisposition', 'LastKnownDate', 'Details', 'Status', 'ResolvedBy', 'ResolvedAt', 'ImportBatchID', 'ImportSource'] },
  LegacyImportBatches: { table: 'LegacyImportBatches', key: 'BatchID', ints: ['TotalRows', 'UniqueMobiles', 'InvalidMobiles'],
    cols: ['BatchID', 'Fingerprint', 'SourceHash', 'CreatedAt', 'CreatedBy', 'Status', 'HeaderJSON', 'TotalRows', 'UniqueMobiles', 'InvalidMobiles', 'ResultJSON', 'UpdatedAt'] },
  LegacyImportRows: { table: 'LegacyImportRows', key: 'RecordKey', ints: ['CSVRow'], bools: ['ValidMobile'],
    cols: ['RecordKey', 'BatchID', 'CSVRow', 'Mobile', 'Name', 'Disposition', 'SourceDate', 'ValidMobile', 'Issue', 'RawJSON'] },
  AuditLog: { table: 'AuditLog', key: null, ints: [], cols: ['Timestamp', 'User', 'Action', 'EntityType', 'EntityID', 'Details'] }
};
/** Columns a person may change by typing in the Sheet. */
const SHEET_EDITABLE = {
  Leads: ['Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Status', 'Disposition', 'Score', 'LastCallAt', 'NextActionType', 'NextFollowupAt', 'Note'],
  CallLog: ['CallDate', 'Response', 'NextActionType', 'NextFollowupAt', 'Note', 'CRM'],
  Users: ['DisplayName', 'Role', 'TeamMemberName', 'Active'],
  Team: ['Active'],
  'CRM Visits': ['PlannedDate', 'Status', 'ActualAt', 'Note'],
  LegacyReview: ['Name', 'Mobile', 'Status']
};

function spec(name) { const t = TABLES[name]; if (!t) fail('Unknown sheet: ' + name); return t; }
function cell(t, col, v) {
  if (t.bools && t.bools.includes(col)) return v === true || String(v).toUpperCase() === 'TRUE' || v === 1 || v === '1' ? 1 : 0;
  if (t.ints.includes(col)) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
  if (v == null) return '';
  if (col === 'Mobile' && (t.table === 'Leads' || t.table === 'LegacyReview')) return normalizeMobile(v) || String(v).trim();
  return String(v);
}
function rowObject(t, headers, row) {
  const o = {};
  headers.forEach((h, i) => { const k = String(h || '').trim(); if (t.cols.includes(k)) o[k] = cell(t, k, row[i]); });
  return o;
}
function checkKey(env, key) {
  if (!env.SYNC_KEY || typeof key !== 'string' || key.length < 16 || key !== env.SYNC_KEY) fail('SYNC_KEY_INVALID');
}

export async function syncApi(env, body) {
  checkKey(env, body.key);
  const db = env.DB;
  switch (body.op) {
    case 'status': {
      const out = {};
      for (const name of Object.keys(TABLES)) out[name] = Number((await first(db, `SELECT COUNT(*) AS n FROM ${q(TABLES[name].table)}`)).n);
      return { ok: true, counts: out, time: new Date().toISOString() };
    }
    case 'reset': {
      const t = spec(body.table);
      await db.batch([stmt(db, `DELETE FROM ${q(t.table)}`)]);
      return { ok: true };
    }
    case 'append': {
      // First-time copy. Rows that break a rule (e.g. same mobile twice) are skipped and reported.
      const t = spec(body.table), headers = body.headers || [], rows = body.rows || [];
      const objs = rows.map(r => rowObject(t, headers, r)).filter(o => Object.values(o).some(v => v !== '' && v !== 0));
      const list = objs.map(o => insertStmt(db, t.table, o, 'INSERT OR IGNORE'));
      const skipped = [];
      if (list.length) {
        const res = await db.batch(list);
        res.forEach((r, i) => { if (!(r.meta && r.meta.changes)) skipped.push(objs[i][t.key || 'Timestamp'] || objs[i].Mobile || ('row ' + (i + 1))); });
      }
      return { ok: true, inserted: objs.length - skipped.length, skipped };
    }
    case 'export': {
      const t = spec(body.table), offset = Math.max(0, Number(body.offset) || 0), limit = Math.min(1000, Math.max(1, Number(body.limit) || 500));
      const [rows, total] = await Promise.all([
        all(db, `SELECT ${t.cols.map(q).join(',')} FROM ${q(t.table)} ORDER BY rowid LIMIT ? OFFSET ?`, limit, offset),
        first(db, `SELECT COUNT(*) AS n FROM ${q(t.table)}`)
      ]);
      return { ok: true, headers: t.cols, rows: rows.map(r => t.cols.map(c => (t.bools && t.bools.includes(c)) ? Number(r[c]) === 1 : r[c])), total: Number(total.n), offset };
    }
    case 'row':
      return sheetRowEdit(env, body);
    default:
      fail('Unknown sync operation.');
  }
}

/** One row typed in the Sheet -> app. Last change wins; the old values stay in AuditLog. */
async function sheetRowEdit(env, body) {
  const db = env.DB, name = body.table, t = spec(name), editable = SHEET_EDITABLE[name];
  if (!editable) return { ok: true, ignored: true, message: 'Is tab ke badlav app mein nahi jaate.' };
  const o = rowObject(t, body.headers || [], body.row || []);
  const now = new Date().toISOString(), who = 'Sheet: ' + String(body.user || 'edit').slice(0, 80);
  const keyVal = o[t.key];
  const existing = keyVal ? await first(db, `SELECT * FROM ${q(t.table)} WHERE ${q(t.key)}=?`, keyVal) : null;

  if (!existing) {
    if (name === 'Leads') {
      // New customer typed in the Sheet: needs a valid, new mobile.
      if (!isValidMobile(o.Mobile || '')) return { ok: false, waiting: true, message: 'Naya customer: 10 digit Mobile daalein, tab app mein jaayega.' };
      const team = await activeTeam(db);
      if (o.CRM && !team.includes(o.CRM)) return { ok: false, message: 'CRM "' + o.CRM + '" Team mein active nahi hai. Sahi naam likhein.' };
      const id = keyVal || uuid();
      const lead = { ID: id, Name: o.Name || '', Mobile: o.Mobile, City: o.City || '', Source: o.Source || 'Sheet', Product: o.Product || '', CRM: o.CRM || '',
        Status: o.Status || 'fresh', Disposition: o.Disposition || 'Yet To Call', Score: o.Score || 8, LastCallAt: o.LastCallAt || '', NextActionType: o.NextActionType || 'Call',
        NextFollowupAt: o.NextFollowupAt || '', Note: o.Note || '', CreatedAt: now, CreatedBy: who, LastUpdatedAt: now, LastUpdatedBy: who, RowVersion: 1, LastReq: '' };
      try {
        await db.batch([insertStmt(db, 'Leads', lead), auditStmt(db, who, 'SHEET_ADD', 'Lead', id, { mobile: lead.Mobile, crm: lead.CRM }, now)]);
      } catch (e) {
        if (isUniqueFailure(e)) return { ok: false, message: 'Ye mobile pehle se kisi aur customer ka hai. Naya customer nahi bana.' };
        throw e;
      }
      return { ok: true, created: true, key: id, message: 'Naya customer app mein jud gaya.' };
    }
    if (name === 'Team' && keyVal) {
      await db.batch([insertStmt(db, 'Team', { Name: keyVal, Active: o.Active ? 1 : 0 }), auditStmt(db, who, 'SHEET_ADD', 'Team', keyVal, o, now)]);
      return { ok: true, created: true, key: keyVal, message: 'Team member jud gaya.' };
    }
    return { ok: false, message: 'Ye row app mein nahi mili (ID khaali ya galat). Nayi entry app se karein.' };
  }

  const changes = {}, set = {};
  editable.forEach(c => {
    if (!(c in o)) return;
    if (String(existing[c] ?? '') !== String(o[c] ?? '')) { changes[c] = { before: existing[c], after: o[c] }; set[c] = o[c]; }
  });
  if (!Object.keys(set).length) return { ok: true, unchanged: true };

  if (name === 'Leads') {
    if ('Mobile' in set && !isValidMobile(set.Mobile)) return { ok: false, message: 'Mobile 10 digit ka hona chahiye. App mein purana mobile hi hai.' };
    if ('CRM' in set && set.CRM && !(await activeTeam(db)).includes(set.CRM)) return { ok: false, message: 'CRM "' + set.CRM + '" Team mein active nahi hai.' };
    Object.assign(set, { LastUpdatedAt: now, LastUpdatedBy: who });
    const list = [stmt(db, `UPDATE Leads SET ${Object.keys(set).map(k => q(k) + '=?').join(',')}, RowVersion=RowVersion+1, LastReq='' WHERE ID=?`, ...Object.values(set), keyVal)];
    list.push(auditStmt(db, who, 'SHEET_EDIT', 'Lead', keyVal, { changes }, now));
    try { await db.batch(list); }
    catch (e) { if (isUniqueFailure(e)) return { ok: false, message: 'Ye mobile pehle se kisi aur customer ka hai. App mein purana mobile hi hai.' }; throw e; }
    return { ok: true, updated: Object.keys(changes), message: 'App mein update ho gaya.' };
  }
  if (name === 'Users') {
    if ('Role' in set && !['Owner', 'CRM'].includes(set.Role)) return { ok: false, message: 'Role sirf Owner ya CRM ho sakta hai.' };
  }
  if (name === 'CRM Visits') set.Version = Number(existing.Version || 0) + 1, set.UpdatedAt = now, set.UpdatedBy = who;
  if (name === 'CallLog') set.UpdatedAt = now, set.UpdatedBy = who;
  await db.batch([
    updateStmt(db, t.table, set, `${q(t.key)}=?`, keyVal),
    auditStmt(db, who, 'SHEET_EDIT', name, keyVal, { changes }, now)
  ]);
  return { ok: true, updated: Object.keys(changes), message: 'App mein update ho gaya.' };
}
