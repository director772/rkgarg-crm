// Smart CRM — old data upload, Legacy Review queue and CALL NOW.
// Same rules as the Apps Script Legacy.gs; original CSV rows are archived.
import { all, first, stmt, insertStmt, updateStmt, guardStmt, auditStmt, isGuardFailure, isUniqueFailure } from './db.js';
import { activeTeam, requireOwner } from './auth.js';
import { leadObj } from './crm.js';
import { fail, uuid, sha256Hex, fmtDate, validRequestId } from './util.js';

const MAX_CUSTOMERS = 200;
const RESOLUTIONS = ['active', 'existing', 'notinterested', 'duplicate', 'invalid'];

/** CSV text -> rows (handles quotes, commas and new lines inside quotes). */
export function parseCsv(textIn) {
  const t = String(textIn).replace(/^﻿/, ''), rows = [];
  let row = [], value = '', quoted = false, afterQuote = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) { if (c === '"') { if (t[i + 1] === '"') { value += '"'; i++; } else { quoted = false; afterQuote = true; } } else value += c; continue; }
    if (c === ',' || c === '\n' || c === '\r') {
      row.push(value); value = ''; afterQuote = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && t[i + 1] === '\n') i++; }
      continue;
    }
    if (afterQuote) { if (c === ' ' || c === '\t') continue; fail('Invalid CSV after quoted field. Save as CSV UTF-8 and retry.'); }
    if (c === '"' && value === '') quoted = true; else value += c;
  }
  if (quoted) fail('CSV has an unclosed quote. Save as CSV UTF-8 and retry.');
  if (row.length || value || afterQuote) rows.push([...row, value]);
  return rows;
}
export function legacyMobile(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(d)) return d;
  if (/^91\d{10}$/.test(d)) return d.slice(2);
  if (/^0091\d{10}$/.test(d)) return d.slice(4);
  if (/^0\d{10}$/.test(d)) return d.slice(1);
  return '';
}
function column(headers, aliases) {
  for (const a of aliases) {
    const m = []; headers.forEach((h, i) => { if (h === a) m.push(i); });
    if (m.length > 1) fail('Duplicate CSV heading: ' + a + '. Keep one clearly named column.');
    if (m.length === 1) return m[0];
  }
  return -1;
}
function indexes(header) {
  const n = header.map(h => String(h || '').replace(/^﻿/, '').trim().toLowerCase());
  const ix = {
    mobile: column(n, ['mobile', 'mobile number', 'mobile no', 'mobile no.', 'phone', 'phone number', 'contact number']),
    name: column(n, ['customer name', 'firm name', 'party name', 'company name', 'name', 'customer']),
    disposition: column(n, ['response', 'customer response', 'last response', 'disposition', 'status']),
    date: column(n, ['call date', 'last call date', 'lastcallat', 'date', 'last known date'])
  };
  if (ix.mobile === -1) fail('Mobile column not found. Use a heading such as "Mobile" or "Mobile Number".');
  return ix;
}
/** Timestamp only when the date is unambiguous (03/10/2026 stays unclear). */
function legacyDate(value) {
  const s = String(value || '').trim(); if (!s) return null;
  let y, m, d, x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = s.match(/^(\d{1,2})[- /]([A-Za-z]{3})[- /](\d{2}|\d{4})$/))) {
    d = +x[1]; m = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(x[2].toLowerCase()) + 1; y = +x[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else if ((x = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    d = +x[1]; m = +x[2]; y = +x[3];
    if (d <= 12 && m <= 12 && d !== m) return null;
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || d < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.getTime();
}
function records(header, src) {
  const ix = indexes(header);
  return src.map(s => {
    const get = i => i < 0 ? '' : String(s.raw[i] == null ? '' : s.raw[i]).trim();
    const mobile = legacyMobile(get(ix.mobile)), disposition = get(ix.disposition), date = get(ix.date), ts = legacyDate(date), issues = [];
    if (!mobile) issues.push('Invalid mobile');
    if (disposition && ts === null) issues.push('Date missing or unclear');
    return { csvRow: s.csvRow, raw: s.raw, mobile, name: get(ix.name), disposition, sourceDate: date, timestamp: ts, issue: issues.join('; ') };
  });
}
function groups(recs) {
  const g = new Map();
  recs.forEach(r => {
    if (!r.mobile) return;
    if (!g.has(r.mobile)) g.set(r.mobile, { mobile: r.mobile, name: r.name || 'Unknown', records: [] });
    const x = g.get(r.mobile); if (x.name === 'Unknown' && r.name) x.name = r.name; x.records.push(r);
  });
  return Array.from(g.values()).map(x => {
    const resp = x.records.filter(r => r.disposition);
    let last = 'Unclear — review history', lastDate = '';
    if (resp.length && resp.every(r => r.timestamp !== null)) {
      const newest = Math.max(...resp.map(r => r.timestamp)), latest = resp.filter(r => r.timestamp === newest), distinct = [...new Set(latest.map(r => r.disposition))];
      lastDate = fmtDate(newest);
      last = distinct.length === 1 ? distinct[0] : 'Multiple responses on latest date — review';
    }
    return { mobile: x.mobile, name: x.name, records: x.records, rows: x.records.length, lastKnownDisposition: last, lastKnownDate: lastDate };
  });
}
const sourceHash = (header, src) => sha256Hex(JSON.stringify({ header, records: src }), 'legacy-source-v1');
function preview(batchId, recs, grps) {
  return { batchId, totalRows: recs.length, uniqueMobiles: grps.length, duplicatesGrouped: grps.filter(g => g.rows > 1).length, invalidMobiles: recs.filter(r => !r.mobile).length,
    preview: grps.slice(0, 10).map(g => ({ mobile: g.mobile, name: g.name, rows: g.rows, lastKnownDisposition: g.lastKnownDisposition, lastKnownDate: g.lastKnownDate })) };
}
async function loadSource(db, batch) {
  const header = JSON.parse(batch.HeaderJSON);
  const rows = await all(db, 'SELECT CSVRow, RawJSON FROM LegacyImportRows WHERE BatchID=?', batch.BatchID);
  const src = rows.map(r => ({ csvRow: Number(r.CSVRow), raw: JSON.parse(r.RawJSON) })).sort((a, b) => a.csvRow - b.csvRow);
  if (src.length !== Number(batch.TotalRows)) fail('Import archive is incomplete. Re-upload the same CSV to repair staging.');
  const seen = new Set();
  src.forEach(r => { if (!Number.isInteger(r.csvRow) || r.csvRow < 2 || !Array.isArray(r.raw) || seen.has(r.csvRow)) fail('Import archive has invalid or duplicate source rows. Contact the owner.'); seen.add(r.csvRow); });
  if (await sourceHash(header, src) !== batch.SourceHash) fail('Archived source data changed after upload. Approval stopped.');
  return { header, src, recs: records(header, src) };
}
/** Many inserts in safe chunks (one transaction each). */
async function batchInChunks(db, list, size = 80) { for (let i = 0; i < list.length; i += size) await db.batch(list.slice(i, i + size)); }

export async function analyzeBulkUpload(env, s, csvText) {
  requireOwner(s);
  const db = env.DB;
  if (typeof csvText !== 'string' || !csvText.trim()) fail('Choose a non-empty CSV file.');
  const parsed = parseCsv(csvText);
  if (parsed.length < 2) fail('CSV needs a header row and at least one data row.');
  const header = parsed[0], src = [];
  for (let i = 1; i < parsed.length; i++) {
    const raw = parsed[i];
    if (!raw.some(v => String(v || '').trim())) continue;
    if (JSON.stringify(raw).length > 40000) fail('CSV row ' + (i + 1) + ' is too large for one archive cell. Shorten or split that row.');
    src.push({ csvRow: i + 1, raw });
  }
  if (!src.length) fail('No non-empty data rows found.');
  if (JSON.stringify(header).length > 40000) fail('CSV header row is too large.');
  const recs = records(header, src), grps = groups(recs);
  if (grps.length > MAX_CUSTOMERS) fail('Maximum ' + MAX_CUSTOMERS + ' unique valid mobiles per upload. Split this CSV.');
  const hash = await sourceHash(header, src), fp = await sha256Hex(s.username + ':' + hash, 'legacy-batch-v1');
  let batch = await first(db, 'SELECT * FROM LegacyImportBatches WHERE Fingerprint=?', fp);
  if (batch) {
    if (batch.CreatedBy !== s.username) fail('Batch ownership mismatch.');
    if (batch.Status !== 'staging') { await loadSource(db, batch); return preview(batch.BatchID, recs, grps); }
  } else {
    const now = new Date().toISOString();
    batch = { BatchID: uuid(), Fingerprint: fp, SourceHash: hash, CreatedAt: now, CreatedBy: s.username, Status: 'staging', HeaderJSON: JSON.stringify(header),
      TotalRows: recs.length, UniqueMobiles: grps.length, InvalidMobiles: recs.filter(r => !r.mobile).length, ResultJSON: '', UpdatedAt: now };
    try { await db.batch([insertStmt(db, 'LegacyImportBatches', batch)]); }
    catch (e) { if (!isUniqueFailure(e)) throw e; batch = await first(db, 'SELECT * FROM LegacyImportBatches WHERE Fingerprint=?', fp); }
  }
  const existing = new Set((await all(db, 'SELECT RecordKey FROM LegacyImportRows WHERE BatchID=?', batch.BatchID)).map(r => r.RecordKey));
  const missing = recs.filter(r => !existing.has(batch.BatchID + ':' + r.csvRow)).map(r => insertStmt(db, 'LegacyImportRows', {
    RecordKey: batch.BatchID + ':' + r.csvRow, BatchID: batch.BatchID, CSVRow: r.csvRow, Mobile: r.mobile, Name: r.name, Disposition: r.disposition,
    SourceDate: r.sourceDate, ValidMobile: r.mobile ? 1 : 0, Issue: r.issue, RawJSON: JSON.stringify(r.raw) }, 'INSERT OR IGNORE'));
  await batchInChunks(db, missing);
  await loadSource(db, batch); // verify the whole archive before offering approval
  await db.batch([updateStmt(db, 'LegacyImportBatches', { Status: 'ready', UpdatedAt: new Date().toISOString() }, 'BatchID=?', batch.BatchID)]);
  return preview(batch.BatchID, recs, grps);
}

export async function approveBulkUpload(env, s, batchId) {
  requireOwner(s);
  const db = env.DB;
  if (!batchId) fail('Missing batch ID.');
  const batch = await first(db, 'SELECT * FROM LegacyImportBatches WHERE BatchID=?', String(batchId));
  if (!batch) fail('Upload batch not found. Analyze the CSV first.');
  if (batch.CreatedBy !== s.username) fail('This upload belongs to another user.');
  if (batch.Status === 'done') return JSON.parse(batch.ResultJSON);
  if (batch.Status !== 'ready' && batch.Status !== 'importing') fail('Upload staging is incomplete. Re-upload the same CSV first.');
  const source = await loadSource(db, batch), grps = groups(source.recs);
  const live = new Set((await all(db, 'SELECT Mobile FROM Leads')).map(r => legacyMobile(r.Mobile)).filter(Boolean));
  const reviews = new Map();
  (await all(db, 'SELECT Mobile, ImportBatchID FROM LegacyReview')).forEach(r => {
    const m = legacyMobile(r.Mobile); if (!m) return;
    if (!reviews.has(m)) reviews.set(m, []); reviews.get(m).push(String(r.ImportBatchID || ''));
  });
  const inserts = []; let added = 0, skippedExisting = 0, skippedLegacy = 0;
  for (const g of grps) {
    const ex = reviews.get(g.mobile) || [];
    if (ex.includes(batch.BatchID)) { added++; continue; } // written by this batch on an earlier try
    if (live.has(g.mobile)) { skippedExisting++; continue; }
    if (ex.length) { skippedLegacy++; continue; }
    const details = g.records.slice(0, 10).map(r => ('CSV row ' + r.csvRow + ': ' + (r.name || '—') + ' — ' + (r.disposition || '—') + (r.sourceDate ? ' (' + r.sourceDate + ')' : '')).slice(0, 700));
    if (g.rows > 10) details.push((g.rows - 10) + ' more source rows preserved in LegacyImportRows.');
    details.push('Full source: LegacyImportRows | BatchID: ' + batch.BatchID + ' | Mobile: ' + g.mobile);
    inserts.push(insertStmt(db, 'LegacyReview', {
      ID: 'LEG-' + await sha256Hex(batch.BatchID + ':' + g.mobile, 'legacy-record-v1'), Name: g.name.slice(0, 200), Mobile: g.mobile, RowsFound: g.rows,
      LastKnownDisposition: g.lastKnownDisposition.slice(0, 1000), LastKnownDate: g.lastKnownDate, Details: JSON.stringify(details), Status: 'pending',
      ResolvedBy: '', ResolvedAt: '', ImportBatchID: batch.BatchID, ImportSource: 'LegacyImportRows' }, 'INSERT OR IGNORE'));
    added++;
  }
  await db.batch([updateStmt(db, 'LegacyImportBatches', { Status: 'importing', UpdatedAt: new Date().toISOString() }, 'BatchID=?', batch.BatchID)]);
  await batchInChunks(db, inserts);
  const result = { success: true, added, skippedExisting, skippedLegacy, invalidMobiles: Number(batch.InvalidMobiles), archivedRows: Number(batch.TotalRows), batchId: batch.BatchID };
  await db.batch([
    auditStmt(db, s.username, 'BULK_IMPORT', 'LegacyReview', batch.BatchID, { legacyBatchId: batch.BatchID, added, skippedExisting, skippedLegacy }),
    updateStmt(db, 'LegacyImportBatches', { Status: 'done', ResultJSON: JSON.stringify(result), UpdatedAt: new Date().toISOString() }, 'BatchID=?', batch.BatchID)
  ]);
  return result;
}

/* ---------------- Review queue ---------------- */

async function requireAccess(db, s) {
  if (s.role === 'Owner') return;
  if (s.role !== 'CRM' || !s.teamMemberName || !(await activeTeam(db)).includes(s.teamMemberName)) fail('An active CRM team membership is required.');
}
function queueItem(g) {
  let details = [];
  try { const p = JSON.parse(g.Details || '[]'); if (Array.isArray(p)) details = p.map(String); }
  catch (e) { details = ['Stored detail summary could not be parsed. Review the source record.']; }
  return { id: g.ID, name: String(g.Name || ''), mobile: String(g.Mobile || ''), rows: Number(g.RowsFound) || 0, lastKnownDisposition: String(g.LastKnownDisposition || 'Unclear'),
    lastKnownDate: String(g.LastKnownDate || ''), details, importBatchId: String(g.ImportBatchID || '') };
}
export async function getLegacyQueue(env, s) {
  await requireAccess(env.DB, s);
  return (await all(env.DB, "SELECT * FROM LegacyReview WHERE Status='pending' ORDER BY rowid LIMIT 100")).map(queueItem);
}
export async function getLegacyPage(env, s, offset, limit) {
  const db = env.DB;
  await requireAccess(db, s);
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  limit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
  const [total, rows] = await Promise.all([
    first(db, "SELECT COUNT(*) AS n FROM LegacyReview WHERE Status='pending'"),
    all(db, "SELECT * FROM LegacyReview WHERE Status='pending' ORDER BY rowid LIMIT ? OFFSET ?", limit, offset)
  ]);
  const n = Number(total.n);
  return { total: n, offset, items: rows.map(queueItem), hasMore: offset + limit < n };
}

async function resolvedResult(db, s, record) {
  const result = { success: true, message: 'Record resolved.' };
  if (!['active', 'existing'].includes(record.Status)) return result;
  const row = await first(db, 'SELECT * FROM Leads WHERE Mobile=?', legacyMobile(record.Mobile));
  if (!row) return result;
  if (s.role === 'Owner' || (s.role === 'CRM' && row.CRM === s.teamMemberName)) {
    result.leadId = row.ID;
    result.lead = leadObj(row);
    result.bootstrap = { team: await activeTeam(db), apiVersion: 4 };
    result.message = s.role === 'Owner' ? 'Customer details aur call form open ho raha hai.' : 'Customer aapki My Calls queue mein hai.';
  } else {
    result.message = 'Customer already main CRM mein hai. Existing assignment safe hai.';
  }
  return result;
}

/** CALL NOW / review actions. One transaction: lead + review status + audit together. */
export async function resolveLegacyRecord(env, s, legacyId, resolutionType, requestId) {
  const db = env.DB;
  await requireAccess(db, s);
  if (s.role === 'CRM' && resolutionType !== 'active') fail('CRM can use Call Now; other review actions are owner-only.');
  if (!RESOLUTIONS.includes(resolutionType)) fail('Invalid resolution type.');
  validRequestId(requestId);
  const record = await first(db, 'SELECT * FROM LegacyReview WHERE ID=?', String(legacyId));
  if (!record) fail('Legacy record not found.');
  if (record.Status !== 'pending') {
    if (record.Status === resolutionType) return resolvedResult(db, s, record);
    fail('This record is already resolved as "' + record.Status + '". Refresh the review queue.');
  }
  const list = [];
  const now = new Date().toISOString();
  if (resolutionType === 'active' || resolutionType === 'existing') {
    const mobile = legacyMobile(record.Mobile);
    if (!mobile) fail('This record has an invalid mobile. It cannot become a live lead.');
    if (!await first(db, 'SELECT ID FROM Leads WHERE Mobile=?', mobile)) {
      const team = await activeTeam(db);
      if (!team.length) fail('No active CRM team member is available.');
      const leadId = 'REC-' + await sha256Hex(String(legacyId), 'legacy-recovered-lead-v1');
      if (await first(db, 'SELECT ID FROM Leads WHERE ID=?', leadId)) fail('Recovered lead ID exists with a different mobile. Contact the owner.');
      list.push(insertStmt(db, 'Leads', {
        ID: leadId, Name: String(record.Name || 'Unknown').slice(0, 200), Mobile: mobile, City: '', Source: 'Legacy Import', Product: '',
        CRM: s.role === 'CRM' ? s.teamMemberName : team[0], Status: resolutionType === 'existing' ? 'interested' : 'fresh',
        Disposition: resolutionType === 'existing' ? 'Existing Customer' : 'Legacy Reactivation', Score: resolutionType === 'existing' ? 9 : 8,
        LastCallAt: '', NextActionType: 'Call', NextFollowupAt: '',
        Note: ('Recovered from legacy data: ' + String(record.LastKnownDisposition || '') + '. Source review ID: ' + legacyId + '\n' + String(record.Details || '')).slice(0, 3000),
        CreatedAt: now, CreatedBy: s.username, LastUpdatedAt: now, LastUpdatedBy: s.username, RowVersion: 1, LastReq: requestId }));
    }
  }
  list.push(
    updateStmt(db, 'LegacyReview', { Status: resolutionType, ResolvedBy: s.username, ResolvedAt: now }, "ID=? AND Status='pending'", String(legacyId)),
    guardStmt(db, 'EXISTS (SELECT 1 FROM LegacyReview WHERE ID=? AND Status=? AND ResolvedAt=?)', String(legacyId), resolutionType, now),
    auditStmt(db, s.username, 'RESOLVE_LEGACY', 'LegacyReview', legacyId, { legacyResolutionKey: String(legacyId) + ':' + resolutionType, resolution: resolutionType }, now)
  );
  try {
    await db.batch(list);
  } catch (e) {
    // Someone resolved it a moment earlier, or the mobile became a live lead: re-check and answer.
    if (!isGuardFailure(e) && !isUniqueFailure(e)) throw e;
    const again = await first(db, 'SELECT * FROM LegacyReview WHERE ID=?', String(legacyId));
    if (again && again.Status === resolutionType) return resolvedResult(db, s, again);
    if (again && again.Status !== 'pending') fail('This record is already resolved as "' + again.Status + '". Refresh the review queue.');
    if (isUniqueFailure(e)) {
      // Mobile became a live lead in between: mark resolved without a new lead.
      await db.batch([
        updateStmt(db, 'LegacyReview', { Status: resolutionType, ResolvedBy: s.username, ResolvedAt: now }, "ID=? AND Status='pending'", String(legacyId)),
        auditStmt(db, s.username, 'RESOLVE_LEGACY', 'LegacyReview', legacyId, { legacyResolutionKey: String(legacyId) + ':' + resolutionType, resolution: resolutionType }, now)
      ]);
      return resolvedResult(db, s, Object.assign({}, record, { Status: resolutionType }));
    }
    throw e;
  }
  return resolvedResult(db, s, Object.assign({}, record, { Status: resolutionType }));
}
