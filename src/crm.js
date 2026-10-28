// Smart CRM — customers, calls, visits and reports on Cloudflare D1.
// Same rules and same results as the Apps Script Leads.gs (revision 4.6),
// so the existing screens work unchanged.
import { all, first, stmt, insertStmt, updateStmt, guardStmt, auditStmt, isGuardFailure, isUniqueFailure } from './db.js';
import { activeTeam, requireOwner } from './auth.js';
import {
  fail, uuid, iso, fmtDate, fmtDateTime, dayKey, text, normalizeMobile, isValidMobile,
  reportDate, validRequestId, stableJson, sha256Hex
} from './util.js';

export const RESPONSE_TO_STATUS = { 'Interested': 'interested', 'Call Later': 'callback', 'Not Picked': 'callback', 'Catalogue Sent': 'interested', 'Visit Scheduled': 'visit', 'No Requirement': 'closed' };
const ALLOWED_ACTIONS = ['Call', 'WhatsApp', 'Catalogue Follow-up', 'Visit Reminder', 'Close Lead'];
export const LEAD_FIELDS = ['ID', 'Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Status', 'Disposition', 'Score', 'LastCallAt', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedAt', 'CreatedBy', 'LastUpdatedAt', 'LastUpdatedBy', 'RowVersion'];

/* ---------------- Reading ---------------- */

const toIso = v => { if (v === '' || v == null) return ''; const d = new Date(v); return isNaN(d.getTime()) ? '' : d.toISOString(); };
/** Display texts are worked out only for customers actually sent to the screen (saves CPU). */
const displayProps = {
  lastCallDisplay: { enumerable: true, get() { return this.lastCallAt ? fmtDateTime(this.lastCallAt) : '—'; } },
  nextFollowupDisplay: { enumerable: true, get() { return this.nextFollowupAt ? fmtDateTime(this.nextFollowupAt) : '—'; } }
};
export function leadObj(r) {
  const o = {
    id: r.ID, name: r.Name, mobile: r.Mobile, city: r.City, source: r.Source, product: r.Product, crm: r.CRM,
    status: r.Status, disposition: r.Disposition, score: Number(r.Score) || 0,
    lastCallAt: toIso(r.LastCallAt), nextActionType: r.NextActionType, nextFollowupAt: toIso(r.NextFollowupAt),
    note: r.Note, createdAt: toIso(r.CreatedAt), rowVersion: Number(r.RowVersion) || 0
  };
  return Object.defineProperties(o, displayProps);
}
/** One request = each table read at most once. */
class Run {
  constructor(env) { this.db = env.DB; this.cache = Object.create(null); }
  async get(key, sql) { if (!this.cache[key]) this.cache[key] = all(this.db, sql); return this.cache[key]; }
  leadRows() { return this.get('leads', 'SELECT * FROM Leads ORDER BY rowid'); }
  async leads() { return (await this.leadRows()).filter(r => r.ID).map(leadObj); }
  /** Only the calls needed (keeps each request light). */
  todayCallRows(now) {
    const [a, b] = dayRangeUtc(dayKey(now), dayKey(now));
    return this.get('callsToday', `SELECT LeadID, CallDate, CRM, CreatedBy FROM CallLog WHERE CallDate >= '${a}' AND CallDate < '${b}' ORDER BY rowid`);
  }
  visitCallRows() { return this.get('visitCalls', "SELECT LeadID FROM CallLog WHERE lower(trim(Response))='visit scheduled'"); }
  visitRows() { return this.get('visits', 'SELECT * FROM Visits ORDER BY rowid'); }
  userRows() { return this.get('users', 'SELECT Username, TeamMemberName FROM Users'); }
  team() { if (!this.cache.team) this.cache.team = activeTeam(this.db); return this.cache.team; }
}

/** India-day range [from 00:00 IST, day after "to" 00:00 IST) as UTC ISO strings. */
function dayRangeUtc(fromDay, toDay) {
  const a = new Date(Date.parse(fromDay + 'T00:00:00+05:30')).toISOString();
  const b = new Date(Date.parse(toDay + 'T00:00:00+05:30') + 86400000).toISOString();
  return [a, b];
}
function callsToday(logs, users, now) {
  const all = new Set(), by = Object.create(null), today = dayKey(now);
  let userTeams = null;
  logs.forEach(r => {
    const d = r.CallDate, id = String(r.LeadID || '');
    if (!d || !id) return;
    const date = new Date(d);
    if (isNaN(date.getTime()) || dayKey(date) !== today) return;
    all.add(id);
    let crm = r.CRM;
    if (!crm) {
      if (!userTeams) { userTeams = Object.create(null); users.forEach(u => userTeams[String(u.Username).trim()] = u.TeamMemberName); }
      crm = userTeams[String(r.CreatedBy).trim()] || '';
    }
    if (crm) { if (!by[crm]) by[crm] = new Set(); by[crm].add(id); }
  });
  const counts = Object.create(null), idsByCrm = Object.create(null);
  Object.keys(by).forEach(k => { counts[k] = by[k].size; idsByCrm[k] = Array.from(by[k]); });
  return { total: all.size, byCrm: counts, ids: Array.from(all), idsByCrm };
}
function bucket(lead, now) {
  if (lead.status === 'closed') return '';
  if (lead.nextFollowupAt) {
    const d = new Date(lead.nextFollowupAt);
    if (d <= now) return 'overdue';
    return dayKey(d) === dayKey(now) ? 'due' : 'upcoming';
  }
  return lead.lastCallAt ? 'unscheduled' : 'fresh';
}
function summary(s, leads, calls, now) {
  const out = { done: s.role === 'Owner' ? calls.total : (calls.byCrm[s.teamMemberName] || 0), fresh: 0, due: 0, overdue: 0, upcoming: 0, unscheduled: 0 };
  leads.forEach(l => { if (s.role === 'CRM' && l.crm !== s.teamMemberName) return; const b = bucket(l, now); if (b) out[b]++; });
  return out;
}
function nextList(s, leads, now) {
  if (!s.teamMemberName) return [];
  const list = leads.filter(l => l.crm === s.teamMemberName && l.status !== 'closed' && (l.nextFollowupAt ? new Date(l.nextFollowupAt) <= now : !l.lastCallAt));
  list.sort((a, b) => {
    const x = a.nextFollowupAt ? 0 : 1, y = b.nextFollowupAt ? 0 : 1;
    return x - y || (x === 0 ? new Date(a.nextFollowupAt) - new Date(b.nextFollowupAt) : b.score - a.score ||
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
  });
  return list;
}
async function legacyPendingCount(db) { return Number(await first(db, "SELECT COUNT(*) AS n FROM LegacyReview WHERE Status='pending'").then(r => r.n)); }
function requireLeadAccess(s, crm) { if (s.role !== 'Owner' && !(s.role === 'CRM' && crm === s.teamMemberName)) fail('Not authorized to access this lead.'); }

export async function getBootstrapData(env, s) {
  const b = { username: s.username, role: s.role, displayName: s.displayName, teamMemberName: s.teamMemberName || '', team: await activeTeam(env.DB), apiVersion: 4, queueDetailsVersion: 1 };
  if (s.role === 'Owner') b.legacyPending = await legacyPendingCount(env.DB);
  return b;
}
export async function getMyQueueSummary(env, s) {
  const r = new Run(env), now = new Date();
  return summary(s, await r.leads(), callsToday(await r.todayCallRows(now), await r.userRows(), now), now);
}
export async function getNextLead(env, s) {
  if (!s.teamMemberName) fail('This login is not linked to a CRM team member. Use the Owner Dashboard.');
  return nextList(s, await new Run(env).leads(), new Date())[0] || null;
}
export async function getMyCallsData(env, s) {
  const started = Date.now(), r = new Run(env), now = new Date();
  const [leads, logs, users] = await Promise.all([r.leads(), r.todayCallRows(now), r.userRows()]);
  const list = nextList(s, leads, now);
  return { summary: summary(s, leads, callsToday(logs, users, now), now), lead: list[0] || null, queue: list.slice(0, 8), serverMs: Date.now() - started };
}

async function ownerDashboard(env, s, searchQuery, allRows, r = new Run(env)) {
  requireOwner(s);
  const q = text(searchQuery, 'Search', 200).toLowerCase(), now = new Date();
  const [team, leads, logs, users, legacyPending] = await Promise.all([r.team(), r.leads(), r.todayCallRows(now), r.userRows(), legacyPendingCount(env.DB)]);
  const calls = callsToday(logs, users, now), perf = Object.create(null), queue = [];
  const kpis = { freshPending: 0, callbacksDue: 0, interested: 0, callsDoneToday: calls.total, upcoming: 0, unscheduled: 0, overdue: 0 };
  team.forEach(t => perf[t] = { fresh: 0, due: 0, overdue: 0, done: calls.byCrm[t] || 0 });
  leads.forEach(l => {
    const b = bucket(l, now);
    if (b === 'fresh') kpis.freshPending++; if (b === 'due') kpis.callbacksDue++; if (b === 'upcoming') kpis.upcoming++;
    if (b === 'unscheduled') kpis.unscheduled++; if (b === 'overdue') kpis.overdue++; if (l.status === 'interested') kpis.interested++;
    if (perf[l.crm] && ['fresh', 'due', 'overdue'].includes(b)) perf[l.crm][b]++;
    if (!q || String(l.name).toLowerCase().includes(q) || String(l.mobile).includes(q) || String(l.crm).toLowerCase().includes(q)) queue.push(l);
  });
  queue.sort((a, b) => b.score - a.score);
  return { kpis, perf, team, legacyPending, queue: allRows ? queue : queue.slice(0, 300), totalMatches: queue.length, hasMore: !allRows && queue.length > 300 };
}
export const getOwnerDashboard = (env, s, q) => ownerDashboard(env, s, q, false);

async function leadById(db, id) { return first(db, 'SELECT * FROM Leads WHERE ID=?', String(id)); }
async function leadByMobile(db, m) { return first(db, 'SELECT * FROM Leads WHERE Mobile=?', String(m)); }

export async function checkDuplicateMobile(env, s, mobile) {
  const m = normalizeMobile(mobile);
  if (!isValidMobile(m)) return { found: false };
  const row = await leadByMobile(env.DB, m);
  if (!row) return { found: false };
  const l = leadObj(row);
  if (s.role === 'CRM' && l.crm !== s.teamMemberName) return { found: true, canAccess: false, name: 'Existing customer', disposition: 'Already assigned to another CRM' };
  return { found: true, canAccess: true, id: l.id, name: l.name, disposition: l.disposition, lead: l };
}
export async function getCustomerProfile(env, s, leadId) {
  const row = await leadById(env.DB, leadId);
  if (!row) fail('Lead not found.');
  const lead = leadObj(row);
  requireLeadAccess(s, lead.crm);
  const logs = await all(env.DB, 'SELECT * FROM CallLog WHERE LeadID=? ORDER BY rowid', lead.id);
  const history = logs.map(g => ({ time: new Date(g.CallDate || g.CreatedAt).getTime(), date: fmtDate(g.CallDate), event: String(g.Response || '') + (g.Note ? ' — ' + g.Note : '') }))
    .sort((a, b) => a.time - b.time).map(h => [h.date, h.event]);
  return { lead, history, canEdit: true, canReassign: s.role === 'Owner' };
}
export async function searchCustomers(env, s, query) {
  const q = text(query, 'Search', 200).toLowerCase();
  if (!q) return { leads: [], legacy: [], hasMore: false };
  const r = new Run(env);
  const matched = (await r.leads()).filter(l => (s.role === 'Owner' || l.crm === s.teamMemberName) && (String(l.name).toLowerCase().includes(q) || String(l.mobile).includes(q)));
  const legacy = [];
  if (s.role === 'Owner') {
    (await all(env.DB, "SELECT ID, Name, Mobile, RowsFound FROM LegacyReview WHERE Status='pending' ORDER BY rowid")).forEach(g => {
      if (String(g.Name).toLowerCase().includes(q) || String(g.Mobile).includes(q)) legacy.push({ id: g.ID, name: g.Name, mobile: g.Mobile, rows: g.RowsFound });
    });
  }
  return { leads: matched.slice(0, 50), legacy: legacy.slice(0, 50), hasMore: matched.length > 50 || legacy.length > 50 };
}
export async function resetCaches(env, s) { requireOwner(s); return 'Caches cleared'; }

export async function getMyQueueDetails(env, s, bucketName, offset, limit) {
  const labels = { done: 'Customers called today', fresh: 'First call pending', due: 'Later today', overdue: 'Overdue / due now', upcoming: 'After today', unscheduled: 'Follow-up missing' };
  if (typeof bucketName !== 'string' || !Object.prototype.hasOwnProperty.call(labels, bucketName)) fail('Select a valid queue card.');
  offset = offset == null ? 0 : Number(offset); limit = limit == null ? 25 : Number(limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Invalid page. Refresh the list and retry.');
  const r = new Run(env), now = new Date(), leads = await r.leads();
  let items;
  if (bucketName === 'done') {
    const called = callsToday(await r.todayCallRows(now), await r.userRows(), now);
    const ids = s.role === 'Owner' ? called.ids : (called.idsByCrm[s.teamMemberName] || []);
    const byId = new Map(leads.map(l => [String(l.id), l]));
    items = ids.map(id => {
      const lead = byId.get(String(id));
      if (!lead || (s.role !== 'Owner' && lead.crm !== s.teamMemberName)) {
        return { id: '', canAccess: false, name: 'Customer details unavailable', mobile: '', city: '', product: '', disposition: "Included in today's call count",
          accessMessage: 'This customer is no longer assigned to you or the record is unavailable. Contact the owner.',
          lastCallAt: '', lastCallDisplay: '—', nextFollowupAt: '', nextFollowupDisplay: '—', note: '' };
      }
      return Object.assign({}, lead, { canAccess: true });
    });
  } else {
    items = leads.filter(l => (s.role === 'Owner' || l.crm === s.teamMemberName) && bucket(l, now) === bucketName).map(l => Object.assign({}, l, { canAccess: true }));
  }
  items.sort((a, b) => {
    if (a.canAccess !== b.canAccess) return a.canAccess ? -1 : 1;
    let d = 0;
    if (['overdue', 'due', 'upcoming'].includes(bucketName)) d = new Date(a.nextFollowupAt).getTime() - new Date(b.nextFollowupAt).getTime();
    else if (bucketName === 'done') d = (Date.parse(b.lastCallAt) || 0) - (Date.parse(a.lastCallAt) || 0);
    else d = (Number(b.score) || 0) - (Number(a.score) || 0);
    return d || String(a.id).localeCompare(String(b.id));
  });
  const total = items.length, pageOffset = total ? Math.min(offset, Math.floor((total - 1) / limit) * limit) : 0;
  return { bucket: bucketName, title: labels[bucketName], total, offset: pageOffset, limit, items: items.slice(pageOffset, pageOffset + limit), hasMore: pageOffset + limit < total,
    restrictedCount: items.filter(i => !i.canAccess).length, asOf: now.toISOString(), asOfDisplay: fmtDateTime(now) };
}

/* ---------------- Call report (owner) ---------------- */

async function ownerCallReport(env, s, fromDate, toDate, offset, limit, exportAll, r = new Run(env)) {
  requireOwner(s);
  const started = Date.now();
  const from = reportDate(fromDate, 'From date'), to = reportDate(toDate, 'To date');
  const days = Math.round((to - from) / 86400000) + 1;
  if (days < 1) fail('From date must be on or before To date.');
  if (days > 366) fail('Select a range of up to 366 days.');
  offset = offset == null ? 0 : Number(offset); limit = limit == null ? 50 : Number(limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Invalid report page.');
  // Only calls in the chosen dates are read; rows with a broken date are counted separately.
  const [a, b] = dayRangeUtc(fromDate, toDate);
  const [logs, users, bad] = await Promise.all([
    all(env.DB, 'SELECT * FROM CallLog WHERE CallDate >= ? AND CallDate < ? ORDER BY rowid', a, b),
    r.userRows(),
    first(env.DB, "SELECT COUNT(*) AS n FROM CallLog WHERE CallDate='' OR CallDate IS NULL OR CallDate NOT LIKE '____-__-__T__:__:__%'")
  ]);
  const matches = [], seenIds = new Set(), byDay = new Map(), byCrm = new Map();
  let invalidDateRecords = Number(bad && bad.n) || 0, duplicateIdRecords = 0, missingLeadRecords = 0, userTeams = null;
  const newBucket = () => ({ records: 0, customers: new Set(), notPicked: 0, otherResponses: 0, responses: Object.create(null) });
  for (let i = 0; i < days; i++) byDay.set(new Date(from.getTime() + i * 86400000).toISOString().slice(0, 10), newBucket());
  const attributed = g => {
    if (g.CRM) return String(g.CRM);
    if (!userTeams) { userTeams = Object.create(null); users.forEach(u => userTeams[String(u.Username || '').trim()] = String(u.TeamMemberName || '')); }
    return userTeams[String(g.CreatedBy || '').trim()] || 'Unassigned / unknown';
  };
  const add = (b, leadId, response) => {
    b.records++; if (leadId) b.customers.add(leadId);
    if (response === 'Not Picked') b.notPicked++; else b.otherResponses++;
    const label = response || 'No response recorded'; b.responses[label] = (b.responses[label] || 0) + 1;
  };
  const totals = newBucket();
  logs.forEach((g, i) => {
    if (!Object.values(g).some(v => v !== '' && v != null)) return;
    const d = g.CallDate ? new Date(g.CallDate) : null;
    if (!d || isNaN(d.getTime())) { invalidDateRecords++; return; }
    const day = dayKey(d);
    if (day < fromDate || day > toDate) return;
    const id = String(g.ID || '');
    if (id && seenIds.has(id)) { duplicateIdRecords++; return; }
    if (id) seenIds.add(id);
    const leadId = String(g.LeadID || ''), crm = attributed(g), response = String(g.Response || '');
    if (!leadId) missingLeadRecords++;
    if (!byCrm.has(crm)) byCrm.set(crm, newBucket());
    add(totals, leadId, response); add(byDay.get(day), leadId, response); add(byCrm.get(crm), leadId, response);
    matches.push({ id, leadId, crm, response, callAt: d.toISOString(), time: d.getTime(), row: i + 2, nextActionType: String(g.NextActionType || ''), nextFollowupAt: g.NextFollowupAt, note: String(g.Note || ''), createdBy: String(g.CreatedBy || '') });
  });
  const key = x => String(x.response || '').trim().toLowerCase();
  matches.sort((a, b) => { const ar = key(a), br = key(b); return (ar === br ? 0 : !ar ? 1 : !br ? -1 : ar < br ? -1 : 1) || b.time - a.time || b.row - a.row; });
  if (exportAll) { offset = 0; limit = Math.max(1, matches.length); }
  const total = matches.length, pageOffset = total ? Math.min(offset, Math.floor((total - 1) / limit) * limit) : 0;
  const page = matches.slice(pageOffset, pageOffset + limit), wanted = new Set(page.map(x => x.leadId)), info = new Map();
  if (page.length) (await r.leadRows()).forEach(l => { if (wanted.has(String(l.ID))) info.set(String(l.ID), { name: String(l.Name || ''), mobile: String(l.Mobile || '') }); });
  const compact = b => ({ records: b.records, uniqueCustomers: b.customers.size, notPicked: b.notPicked, otherResponses: b.otherResponses, responses: b.responses });
  return {
    fromDate, toDate, timeZone: 'Asia/Kolkata', asOf: new Date().toISOString(),
    totals: compact(totals),
    byDay: Array.from(byDay, ([date, b]) => Object.assign({ date }, compact(b))),
    byCrm: Array.from(byCrm, ([crm, b]) => Object.assign({ crm }, compact(b))).sort((a, b) => b.records - a.records || a.crm.localeCompare(b.crm)),
    items: page.map(x => {
      const lead = info.get(x.leadId), nf = x.nextFollowupAt ? new Date(x.nextFollowupAt) : null;
      return { id: x.id, leadId: lead ? x.leadId : '', canAccess: !!lead, name: lead ? (lead.name || 'Name not available') : 'Customer unavailable', mobile: lead ? lead.mobile : '',
        crm: x.crm, response: x.response, callAt: x.callAt, callDisplay: fmtDateTime(x.callAt), nextActionType: x.nextActionType,
        nextFollowupDisplay: nf && !isNaN(nf.getTime()) ? fmtDateTime(nf) : '—', note: x.note, createdBy: x.createdBy };
    }),
    total, offset: pageOffset, limit, hasMore: pageOffset + limit < total,
    warnings: { invalidDateRecordsAllTime: invalidDateRecords, duplicateIdsSkippedInRange: duplicateIdRecords, missingLeadIdsInRange: missingLeadRecords },
    serverMs: Date.now() - started
  };
}
export const getOwnerCallReport = (env, s, f, t, o, l) => ownerCallReport(env, s, f, t, o, l, false);

/* ---------------- Visits ---------------- */

const visitDay = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) && s.length === 10 ? s : (s ? (isNaN(new Date(s)) ? s : dayKey(s)) : ''); };

async function visitDashboard(env, s, fromDate, toDate, r = new Run(env)) {
  reportDate(fromDate, 'From date'); reportDate(toDate, 'To date');
  if (fromDate > toDate) fail('Check visit date range.');
  const leads = {}; (await r.leads()).forEach(l => leads[l.id] = l);
  const today = dayKey(new Date()), items = [];
  (await r.visitRows()).forEach(g => {
    const lead = leads[g.LeadID];
    if (!lead || (s.role !== 'Owner' && lead.crm !== s.teamMemberName)) return;
    const date = visitDay(g.PlannedDate), actual = iso(g.ActualAt, 'Actual visit');
    items.push({ id: g.ID, leadId: lead.id, name: lead.name, mobile: lead.mobile, crm: lead.crm, date, status: g.Status, actual,
      actualDisplay: actual ? fmtDateTime(actual) : '—', convertedDisplay: g.Status === 'Converted' ? fmtDateTime(g.UpdatedAt) : '—', note: g.Note, version: Number(g.Version) });
  });
  // Earlier "Visit Scheduled" responses without a visit record appear once per customer.
  const represented = new Set(items.map(v => String(v.leadId))), candidates = new Set();
  Object.values(leads).forEach(l => { if (String(l.disposition || '').trim().toLowerCase() === 'visit scheduled') candidates.add(String(l.id)); });
  (await r.visitCallRows()).forEach(g => candidates.add(String(g.LeadID || '')));
  candidates.forEach(id => {
    const lead = leads[id];
    if (!lead || represented.has(id) || (s.role !== 'Owner' && lead.crm !== s.teamMemberName)) return;
    represented.add(id);
    items.push({ id: 'legacy-visit:' + id, leadId: lead.id, name: lead.name, mobile: lead.mobile, crm: lead.crm, date: '', status: 'Planned', actual: '', actualDisplay: '—', convertedDisplay: '—',
      note: 'Earlier Visit Scheduled response — confirm visit date or update outcome.', version: 0, legacy: true });
  });
  const pending = v => ['Planned', 'Rescheduled'].includes(v.status), scheduled = items.filter(v => v.date === today && v.status !== 'Cancelled');
  const counts = { scheduled: scheduled.length, arrived: scheduled.filter(v => ['Done', 'Converted'].includes(v.status)).length, remaining: scheduled.filter(pending).length,
    doneToday: items.filter(v => v.actual && dayKey(v.actual) === today).length, overdue: items.filter(v => pending(v) && !!v.date && v.date < today).length };
  return { today, counts, items: items.sort((a, b) => a.date.localeCompare(b.date)), fromDate, toDate };
}
export const getVisitDashboard = (env, s, f, t) => visitDashboard(env, s, f, t);

export async function getCrmScreenData(env, s, screen, fromDate, toDate) {
  const started = Date.now(), r = new Run(env), today = dayKey(new Date());
  if (screen === 'owner') requireOwner(s); else if (screen !== 'calls') fail('Unknown dashboard.');
  const capture = async fn => { try { return await fn(); } catch (e) { return { loadError: String(e.message || e) }; } };
  let result;
  if (screen === 'owner') result = { report: await capture(() => ownerCallReport(env, s, fromDate, toDate, 0, 50, false, r)) };
  else result = { calls: await capture(async () => { const now = new Date(), leads = await r.leads(); return { summary: summary(s, leads, callsToday(await r.todayCallRows(now), await r.userRows(), now), now), lead: nextList(s, leads, now)[0] || null }; }) };
  result.visits = await capture(() => visitDashboard(env, s, today, today, r));
  result.serverMs = Date.now() - started;
  return result;
}
export async function getDashboardExcelData(env, s, fromDate, toDate, visitFrom, visitTo) {
  requireOwner(s);
  const r = new Run(env);
  const calls = await ownerCallReport(env, s, fromDate, toDate, 0, 50, true, r);
  const visits = await visitDashboard(env, s, visitFrom, visitTo, r);
  const dashboard = await ownerDashboard(env, s, '', true, r);
  return { generatedAt: fmtDateTime(new Date()), calls, visits, dashboard };
}

/* ---------------- Saving (safe, all-or-nothing) ---------------- */

/**
 * Every save runs as ONE database transaction. The request ID is stored with
 * the result, so pressing Retry (or a double click) never creates a second
 * entry. A save built on old data is cancelled by a guard (RowVersion check),
 * so newer data is never overwritten.
 */
async function operation(env, s, action, requestId, input, build) {
  validRequestId(requestId);
  const db = env.DB;
  const fp = await sha256Hex(stableJson([s.username, s.role, s.teamMemberName, action, input]), 'crm-operation-v1');
  const previous = async () => {
    const old = await first(db, 'SELECT * FROM Requests WHERE RequestID=? OR Fingerprint=? ORDER BY CASE WHEN RequestID=? THEN 0 ELSE 1 END LIMIT 1', requestId, fp, requestId);
    if (!old) return null;
    if (old.User !== s.username || old.Action !== action || old.Fingerprint !== fp) fail('Request ID was already used for a different operation.');
    return JSON.parse(old.Result);
  };
  const done = await previous();
  if (done) return done;
  const built = await build();
  if (built.early) return built.early;
  const result = built.result;
  const list = [insertStmt(db, 'Requests', { RequestID: requestId, Action: action, User: s.username, Fingerprint: fp, Result: JSON.stringify(result), CreatedAt: new Date().toISOString() })].concat(built.statements);
  try {
    await db.batch(list);
    return result;
  } catch (e) {
    if (isUniqueFailure(e, 'Requests')) { const again = await previous(); if (again) return again; }
    if (isGuardFailure(e) && built.onConflict) return built.onConflict();
    if (isUniqueFailure(e, 'Leads.Mobile') && built.onDuplicate) return built.onDuplicate();
    throw e;
  }
}

function leadInput(p) {
  if (!p) fail('Missing lead details.');
  return { mobile: normalizeMobile(p.mobile), name: text(p.name, 'Customer name', 200), city: text(p.city, 'City', 150), source: text(p.source, 'Source', 100),
    product: text(p.product, 'Product', 500), crm: text(p.crm, 'CRM', 150), note: text(p.note, 'Note', 3000) };
}
async function validateLead(db, x, allowUnknown, productOptional, cityOptional) {
  if (!isValidMobile(x.mobile)) fail('Enter a valid 10 digit mobile number.');
  const labels = allowUnknown === true ? { source: 'Source' } : { name: 'Customer name', city: 'City', source: 'Source', product: 'Product / requirement' };
  if (productOptional === true) delete labels.product;
  if (cityOptional === true) delete labels.city;
  Object.keys(labels).forEach(k => { if (!x[k]) fail(labels[k] + ' is required.'); });
  if (!x.crm || !(await activeTeam(db)).includes(x.crm)) fail('Select an active CRM team member.');
}
function callInput(p) {
  return { leadId: String(p.leadId || ''), version: Number(p.knownRowVersion), response: text(p.response, 'Response', 100), nextActionType: text(p.nextActionType, 'Next action', 100),
    nextFollowupAt: iso(p.nextFollowupAt, 'Next follow-up'), note: text(p.note, 'Note', 3000), callDate: iso(p.callDate, 'Call date'),
    visitDate: p.response === 'Visit Scheduled' ? String(p.visitDate || '') : '' };
}
function validateCall(x, now) {
  if (!Object.prototype.hasOwnProperty.call(RESPONSE_TO_STATUS, x.response)) fail('Select a valid customer response.');
  if (x.response === 'Visit Scheduled') { reportDate(x.visitDate, 'Visit date'); if (x.visitDate < dayKey(now)) fail('Visit date cannot be in the past.'); }
  const callDate = x.callDate ? new Date(x.callDate) : now;
  if (callDate.getTime() > now.getTime() + 60000) fail('Call date cannot be in the future.');
  const closed = x.response === 'No Requirement';
  if (!closed) {
    if (!ALLOWED_ACTIONS.includes(x.nextActionType) || x.nextActionType === 'Close Lead') fail('Select a valid next action for this open lead.');
    if (!x.nextFollowupAt) fail('Enter the next follow-up date and time.');
    if (new Date(x.nextFollowupAt) <= now) fail('Next follow-up must be a future date and time.');
  }
  return { date: callDate.toISOString(), action: closed ? 'Close Lead' : x.nextActionType, followup: closed ? '' : x.nextFollowupAt };
}
function requireVersion(x) { if (!Number.isInteger(x.version) || x.version < 1) fail('Missing row version. Refresh this lead before saving.'); }
const conflictResult = row => ({ success: false, conflict: true, latest: leadObj(row), message: 'This lead changed. Review the latest details before saving.' });
function duplicateResult(s, row) {
  const lead = leadObj(row), result = { success: false, duplicate: true, message: 'This mobile already exists. Duplicate lead was not created.' };
  if (s.role === 'Owner' || lead.crm === s.teamMemberName) result.existing = lead;
  return result;
}

/** Call history row: same customer + same day + same response updates one record (as before). */
async function callLogPlan(db, s, leadId, crm, timing, x, stamp) {
  const logs = await all(db, 'SELECT * FROM CallLog WHERE LeadID=? AND Response=?', leadId, x.response);
  const day = dayKey(timing.date);
  const same = logs.filter(g => g.CallDate && !isNaN(new Date(g.CallDate)) && dayKey(g.CallDate) === day);
  if (same.length > 1) fail('Duplicate call-history rows for this response/date. Ask the owner to review.');
  const before = same[0] || null;
  if (before && !before.ID) fail('Existing call-history row has no ID. Ask the owner to correct it.');
  const log = before ? Object.assign({}, before) : { ID: uuid(), LeadID: leadId, CallDate: timing.date, Response: x.response, NextActionType: '', NextFollowupAt: '', Note: '', CreatedBy: s.username, CreatedAt: stamp, CRM: crm, UpdatedAt: '', UpdatedBy: '' };
  Object.assign(log, { NextActionType: timing.action, NextFollowupAt: timing.followup, UpdatedAt: stamp, UpdatedBy: s.username });
  if (x.note || !before) log.Note = x.note;
  if (before) {
    const { ID, ...rest } = log;
    return [updateStmt(db, 'CallLog', rest, 'ID=?', ID)];
  }
  return [insertStmt(db, 'CallLog', log)];
}
/** Visit Scheduled response creates / reschedules the confirmed visit in the same save. */
async function visitPlan(db, call, leadId, crm, user, stamp) {
  if (call.response !== 'Visit Scheduled') return [];
  const active = await all(db, "SELECT * FROM Visits WHERE LeadID=? AND Status IN ('Planned','Rescheduled')", leadId);
  if (active.length > 1) fail('Multiple pending visits found. Resolve them in Manage visits first.');
  const old = active[0] || null, oldDate = old ? visitDay(old.PlannedDate) : '';
  const visit = { ID: old ? old.ID : uuid(), LeadID: leadId, CRM: crm, PlannedDate: call.visitDate, Status: old && oldDate !== call.visitDate ? 'Rescheduled' : old ? old.Status : 'Planned',
    ActualAt: '', Note: call.note || (old && old.Note) || '', Version: old ? Number(old.Version) + 1 : 1, UpdatedAt: stamp, UpdatedBy: user };
  if (!old) return [insertStmt(db, 'Visits', visit)];
  const { ID, ...rest } = visit;
  return [updateStmt(db, 'Visits', rest, 'ID=? AND Version=?', ID, Number(old.Version)), guardStmt(db, 'EXISTS (SELECT 1 FROM Visits WHERE ID=? AND Version=? AND UpdatedAt=?)', ID, visit.Version, stamp)];
}
/** Update a lead only if nobody changed it since it was read (RowVersion). */
function leadUpdate(db, before, after, requestId) {
  const fields = {};
  LEAD_FIELDS.forEach(k => { if (k !== 'ID') fields[k] = after[k]; });
  fields.LastReq = requestId;
  return [
    updateStmt(db, 'Leads', fields, 'ID=? AND RowVersion=?', before.ID, Number(before.RowVersion)),
    guardStmt(db, 'EXISTS (SELECT 1 FROM Leads WHERE ID=? AND LastReq=?)', before.ID, requestId)
  ];
}
const pick = r => { const o = {}; LEAD_FIELDS.forEach(k => o[k] = r[k]); return o; };

async function createLeadImpl(env, s, payload, requestId, withCall) {
  const db = env.DB, input = leadInput(payload);
  if (withCall) { if (!payload.call) fail('Missing first-call details.'); const c = callInput(payload.call); delete c.leadId; delete c.version; input.call = c; }
  return operation(env, s, withCall ? 'CREATE_LEAD_CALL' : 'CREATE_LEAD', requestId, input, async () => {
    // Only a recorded unanswered FIRST call allows unknown customer details.
    await validateLead(db, input, withCall === true && input.call.response === 'Not Picked', withCall !== true, withCall !== true);
    if (withCall && s.role === 'CRM' && input.crm !== s.teamMemberName) fail('To record the first call, assign this lead to your own CRM name.');
    const dup = await leadByMobile(db, input.mobile);
    if (dup) return { early: duplicateResult(s, dup) };
    const now = new Date(), stamp = now.toISOString(), id = uuid();
    const lead = { ID: id, Name: input.name, Mobile: input.mobile, City: input.city, Source: input.source, Product: input.product, CRM: input.crm, Status: 'fresh', Disposition: 'Yet To Call', Score: 8,
      LastCallAt: '', NextActionType: 'Call', NextFollowupAt: '', Note: input.note, CreatedAt: stamp, CreatedBy: s.username, LastUpdatedAt: stamp, LastUpdatedBy: s.username, RowVersion: 1, LastReq: requestId };
    const list = [];
    const details = { mobile: input.mobile, crm: input.crm, requestId };
    if (withCall) {
      const c = input.call, timing = validateCall(c, now);
      Object.assign(lead, { Status: RESPONSE_TO_STATUS[c.response], Disposition: c.response, LastCallAt: timing.date, NextActionType: timing.action, NextFollowupAt: timing.followup, Note: c.note || input.note });
      list.push(insertStmt(db, 'CallLog', { ID: uuid(), LeadID: id, CallDate: timing.date, Response: c.response, NextActionType: timing.action, NextFollowupAt: timing.followup, Note: c.note || input.note, CreatedBy: s.username, CreatedAt: stamp, CRM: input.crm, UpdatedAt: stamp, UpdatedBy: s.username }));
      list.push(...await visitPlan(db, c, id, input.crm, s.username, stamp));
      details.response = c.response;
    }
    list.unshift(insertStmt(db, 'Leads', lead));
    list.push(auditStmt(db, s.username, withCall ? 'CREATE_LEAD_CALL' : 'CREATE_LEAD', 'Lead', id, details, stamp));
    return { result: { success: true, leadId: id }, statements: list, onDuplicate: async () => duplicateResult(s, await leadByMobile(db, input.mobile)) };
  });
}
export const createLead = (env, s, p, id) => createLeadImpl(env, s, p, id, false);
export const createLeadAndCall = (env, s, p, id) => createLeadImpl(env, s, p, id, true);

export async function updateLead(env, s, payload, requestId) {
  const db = env.DB, x = leadInput(payload);
  x.leadId = String(payload.leadId || ''); x.version = Number(payload.knownRowVersion); requireVersion(x);
  return operation(env, s, 'EDIT_LEAD', requestId, x, async () => {
    const row = await leadById(db, x.leadId);
    if (!row) fail('Lead not found.');
    requireLeadAccess(s, row.CRM);
    if (Number(row.RowVersion) !== x.version) return { early: conflictResult(row) };
    await validateLead(db, x);
    if (s.role === 'CRM' && x.crm !== row.CRM) fail('Only the owner can reassign an existing lead.');
    const dup = await leadByMobile(db, x.mobile);
    if (dup && dup.ID !== row.ID) return { early: duplicateResult(s, dup) };
    const before = pick(row), stamp = new Date().toISOString();
    const after = Object.assign({}, before, { Name: x.name, Mobile: x.mobile, City: x.city, Source: x.source, Product: x.product, CRM: x.crm, Note: x.note, LastUpdatedAt: stamp, LastUpdatedBy: s.username, RowVersion: Number(before.RowVersion) + 1 });
    const changes = {};
    ['Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Note'].forEach(h => { if (String(before[h]) !== String(after[h])) changes[h] = { before: before[h], after: after[h] }; });
    if (!Object.keys(changes).length) return { early: { success: true, unchanged: true, leadId: x.leadId } };
    return {
      result: { success: true, leadId: x.leadId },
      statements: [...leadUpdate(db, before, after, requestId), auditStmt(db, s.username, 'EDIT_LEAD', 'Lead', x.leadId, { rowVersion: after.RowVersion, changes, requestId }, stamp)],
      onConflict: async () => conflictResult(await leadById(db, x.leadId)),
      onDuplicate: async () => duplicateResult(s, await leadByMobile(db, x.mobile))
    };
  });
}

async function callSave(env, s, x, requestId, action, details) {
  const db = env.DB;
  return operation(env, s, action, requestId, details ? Object.assign({}, x, { details }) : x, async () => {
    const row = await leadById(db, x.leadId);
    if (!row) fail('Lead not found.');
    requireLeadAccess(s, row.CRM);
    if (Number(row.RowVersion) !== x.version) return { early: conflictResult(row) };
    if (details) {
      if (row.Source !== 'Legacy Import') fail('This combined form is only for legacy customers.');
      await validateLead(db, details, x.response === 'Not Picked');
      if (details.crm !== row.CRM) fail('Keep the assigned CRM unchanged while saving this call.');
      const dup = await leadByMobile(db, details.mobile);
      if (dup && dup.ID !== row.ID) return { early: duplicateResult(s, dup) };
    }
    const now = new Date(), timing = validateCall(x, now), stamp = now.toISOString();
    const before = pick(row);
    const after = Object.assign({}, before, details ? { Name: details.name, Mobile: details.mobile, City: details.city, Source: details.source, Product: details.product, CRM: details.crm } : {}, {
      Status: RESPONSE_TO_STATUS[x.response], Disposition: x.response, LastCallAt: timing.date, NextActionType: timing.action, NextFollowupAt: timing.followup,
      Note: x.note || before.Note || '', LastUpdatedAt: stamp, LastUpdatedBy: s.username, RowVersion: Number(before.RowVersion) + 1 });
    const list = [
      ...leadUpdate(db, before, after, requestId),
      ...await callLogPlan(db, s, x.leadId, before.CRM, timing, x, stamp),
      ...await visitPlan(db, x, x.leadId, before.CRM, s.username, stamp),
      auditStmt(db, s.username, action, 'Lead', x.leadId, { response: x.response, rowVersion: after.RowVersion, requestId }, stamp)
    ];
    return { result: { success: true, leadId: x.leadId }, statements: list,
      onConflict: async () => conflictResult(await leadById(db, x.leadId)),
      onDuplicate: details ? async () => duplicateResult(s, await leadByMobile(db, details.mobile)) : null };
  });
}
export async function saveCallOutcome(env, s, payload, requestId) {
  if (!payload || !payload.leadId) fail('Missing lead.');
  const x = callInput(payload); requireVersion(x);
  if (!Object.prototype.hasOwnProperty.call(RESPONSE_TO_STATUS, x.response)) fail('Select a valid customer response.');
  return callSave(env, s, x, requestId, 'SAVE_CALL', null);
}
export async function saveLegacyDetailsAndCall(env, s, payload, requestId) {
  if (!payload || !payload.leadId) fail('Missing lead.');
  const details = leadInput(payload);
  if (!payload.call) fail('Missing call response.');
  const x = callInput(Object.assign({}, payload.call, { leadId: payload.leadId, knownRowVersion: payload.knownRowVersion })); requireVersion(x);
  if (!Object.prototype.hasOwnProperty.call(RESPONSE_TO_STATUS, x.response)) fail('Select a valid customer response.');
  return callSave(env, s, x, requestId, 'LEGACY_DETAILS_CALL', details);
}

export async function saveCustomerVisit(env, s, p, requestId) {
  const db = env.DB;
  p = p || {};
  const x = { leadId: String(p.leadId || ''), visitId: String(p.visitId || ''), version: Number(p.version) || 0, status: String(p.status || ''), date: String(p.date || ''), note: text(p.note, 'Visit note', 3000) };
  return operation(env, s, 'SAVE_VISIT', requestId, x, async () => {
    const row = await leadById(db, x.leadId);
    if (!row) fail('Lead not found.');
    requireLeadAccess(s, row.CRM);
    const old = x.visitId ? await first(db, 'SELECT * FROM Visits WHERE ID=?', x.visitId) : null;
    if (x.visitId && !old) fail('Visit not found.');
    if (old && (old.LeadID !== x.leadId || Number(old.Version) !== x.version)) fail('Visit changed. Refresh visits and reopen it.');
    if (!['Planned', 'Rescheduled', 'Done', 'Cancelled', 'Converted'].includes(x.status)) fail('Choose a visit status.');
    if (x.date) reportDate(x.date, 'Visit date');
    if (['Planned', 'Rescheduled'].includes(x.status) && !x.date) fail('Enter the confirmed visit date.');
    if (['Planned', 'Rescheduled'].includes(x.status) && x.date < dayKey(new Date())) fail('Planned visit date cannot be in the past.');
    if (!old && x.status === 'Rescheduled') fail('Create a planned visit first.');
    if (old && (['Cancelled', 'Converted'].includes(old.Status) || (old.Status === 'Done' && x.status !== 'Converted'))) fail('This visit is finished. Done visits can only be marked Converted after purchase.');
    if (old && old.Status === 'Done') x.date = visitDay(old.PlannedDate);
    if (!old && (await all(db, "SELECT 1 FROM Visits WHERE LeadID=? AND Status IN ('Planned','Rescheduled')", x.leadId)).length) fail('This customer already has a pending visit. Update that visit.');
    const stamp = new Date().toISOString();
    const visit = { ID: old ? old.ID : uuid(), LeadID: x.leadId, CRM: row.CRM, PlannedDate: x.date || (old && visitDay(old.PlannedDate)) || '', Status: x.status,
      ActualAt: ['Done', 'Converted'].includes(x.status) ? ((old && old.ActualAt) || stamp) : '', Note: x.note, Version: old ? Number(old.Version) + 1 : 1, UpdatedAt: stamp, UpdatedBy: s.username };
    const before = pick(row), after = Object.assign({}, before, { RowVersion: Number(before.RowVersion) + 1, LastUpdatedAt: stamp, LastUpdatedBy: s.username });
    const list = [...leadUpdate(db, before, after, requestId)];
    if (old) { const { ID, ...rest } = visit; list.push(updateStmt(db, 'Visits', rest, 'ID=? AND Version=?', ID, Number(old.Version)), guardStmt(db, 'EXISTS (SELECT 1 FROM Visits WHERE ID=? AND Version=? AND UpdatedAt=?)', ID, visit.Version, stamp)); }
    else list.push(insertStmt(db, 'Visits', visit));
    list.push(auditStmt(db, s.username, 'SAVE_VISIT', 'Lead', x.leadId, { before: old, after: visit, requestId }, stamp));
    return { result: { success: true, leadId: x.leadId }, statements: list, onConflict: async () => fail('Visit changed. Refresh visits and reopen it.') };
  });
}
