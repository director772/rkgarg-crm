// Full API test on a local SQLite copy of the D1 schema.
import { D1Shim } from './d1shim.js';
import { handle } from '../src/api.js';
import { sha256Hex } from '../src/util.js';

const env = { DB: new D1Shim(new URL('../schema.sql', import.meta.url).pathname), SYNC_KEY: 'test-sync-key-1234567890' };
let ok = 0, bad = 0;
const check = (c, m) => { if (c) { ok++; console.log('ok -', m); } else { bad++; console.log('FAIL -', m); } };
const BASE = process.env.BASE;
async function call(name, body) {
  if (BASE) return (await fetch(BASE + '/api/' + name, { method: 'POST', body: JSON.stringify(body) })).json();
  const res = await handle(new Request('https://x/api/' + name, { method: 'POST', body: JSON.stringify(body) }), env, name);
  return res.json();
}
const api = async (name, token, ...args) => { const r = await call(name, { token, args }); if (!r.ok) throw new Error(r.error); return r.result; };
const apiErr = async (name, token, ...args) => { const r = await call(name, { token, args }); return r.ok ? null : r.error; };
const sync = async body => { const r = await call('sync', Object.assign({ key: env.SYNC_KEY }, body)); return r.ok ? r.result : r; };
const future = days => new Date(Date.now() + days * 86400000).toISOString();
const istDay = ms => new Date(ms + 19800000).toISOString().slice(0, 10);
const today = istDay(Date.now());

// ---------- Sheet copy (first-time import) ----------
const salt1 = 'salt-owner', salt2 = 'salt-neha';
await sync({ op: 'append', table: 'Users', headers: ['Username', 'PasswordHash', 'Salt', 'DisplayName', 'Role', 'TeamMemberName', 'Active'],
  rows: [['owner', await sha256Hex('pass1234', salt1), salt1, 'Owner', 'Owner', '', true], [' neha ', await sha256Hex('pass1234', salt2), salt2, 'Neha', 'CRM', ' Neha', 'TRUE']] });
await sync({ op: 'append', table: 'Team', headers: ['Name', 'Active'], rows: [['Neha', true], ['Bhawna', true], ['Old', false]] });
const imp = await sync({ op: 'append', table: 'Leads', headers: ['ID', 'Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Status', 'Disposition', 'Score', 'LastCallAt', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedAt', 'CreatedBy', 'LastUpdatedAt', 'LastUpdatedBy', 'RowVersion'],
  rows: [
    ['L1', 'Aman Traders', 9810000001, 'Delhi', 'WhatsApp', 'Jeans', 'Neha', 'fresh', 'Yet To Call', 8, '', 'Call', '', '', '2026-10-01T05:00:00.000Z', 'owner', '', '', 1],
    ['L2', 'Bala Fashion', '9810000002', 'Agra', 'Meta Ad', 'Kids', 'Neha', 'callback', 'Call Later', 8, '2026-10-20T05:00:00.000Z', 'Call', '2026-10-21T05:00:00.000Z', 'old note', '2026-10-02T05:00:00.000Z', 'owner', '', '', 3],
    ['L3', 'Dup Mobile', '9810000001', '', '', '', 'Neha', 'fresh', '', 8, '', 'Call', '', '', '', '', '', '', 1]
  ] });
check(imp.ok && imp.inserted === 2 && imp.skipped.length === 1, 'import: duplicate mobile row skipped and reported: ' + JSON.stringify(imp.skipped));
check((await call('sync', { key: 'wrong-key-wrong-key', op: 'status' })).error === 'SYNC_KEY_INVALID', 'sync needs the secret key');

// ---------- Login ----------
check(await apiErr('login', null, 'neha', 'nope') === 'Invalid username or password.', 'wrong password rejected');
const owner = (await call('login', { args: ['owner', 'pass1234'] })).result.token;
const neha = (await call('login', { args: ['neha', 'pass1234'] })).result.token;
check(!!owner && !!neha, 'existing passwords work (same hash as Apps Script)');
check(await apiErr('getMyCallsData', 'bad-token') === 'SESSION_EXPIRED', 'bad token -> SESSION_EXPIRED');

// ---------- My Calls ----------
let mc = await api('getMyCallsData', neha);
check(mc.lead && mc.lead.name === 'Bala Fashion' && mc.queue.length === 2, 'My Calls: overdue follow-up first, queue has 2');
check(mc.summary.overdue === 1 && mc.summary.fresh === 1, 'summary counts: ' + JSON.stringify(mc.summary));
check(mc.lead.nextFollowupDisplay === '21-Oct-26 10:30 AM', 'India time display: ' + mc.lead.nextFollowupDisplay);

// save call, retry, conflict
const save = { leadId: 'L2', knownRowVersion: 3, response: 'Interested', nextActionType: 'WhatsApp', nextFollowupAt: future(2), note: 'achha laga' };
const s1 = await api('saveCallOutcome', neha, save, 'req-0000001');
check(s1.success, 'save call');
const s1b = await api('saveCallOutcome', neha, save, 'req-0000001');
check(s1b.success && (await sync({ op: 'status' })).counts.CallLog === 1, 'Retry same save: no second entry');
const s2 = await api('saveCallOutcome', neha, Object.assign({}, save, { response: 'Call Later' }), 'req-0000002');
check(s2.conflict && s2.latest.rowVersion === 4, 'old version -> conflict with latest details');
const prof = await api('getCustomerProfile', neha, 'L2');
check(prof.lead.disposition === 'Interested' && prof.lead.note === 'achha laga' && prof.history.length === 1, 'profile shows saved call');
mc = await api('getMyCallsData', neha);
check(mc.summary.done === 1 && mc.lead.name === 'Aman Traders', 'called today = 1, next is Aman');

// concurrent saves on the same lead: only one wins
const L1v = mc.lead.rowVersion;
const [c1, c2] = await Promise.all([
  api('saveCallOutcome', neha, { leadId: 'L1', knownRowVersion: L1v, response: 'Not Picked', nextActionType: 'Call', nextFollowupAt: future(1), note: '' }, 'req-0000003'),
  api('saveCallOutcome', neha, { leadId: 'L1', knownRowVersion: L1v, response: 'Catalogue Sent', nextActionType: 'Call', nextFollowupAt: future(1), note: '' }, 'req-0000004')
]);
check([c1, c2].filter(r => r.success).length === 1 && [c1, c2].filter(r => r.conflict).length === 1, 'two people saving same customer: one saved, other told it changed');

// validation
check(/future/.test(await apiErr('saveCallOutcome', neha, { leadId: 'L1', knownRowVersion: L1v + 1, response: 'Interested', nextActionType: 'Call', nextFollowupAt: future(-1) }, 'req-0000005')), 'past follow-up rejected');

// ---------- New lead ----------
const nl = { mobile: '9123456789', name: 'Shyam', city: 'Agra', source: 'Reference', product: 'Jeans', crm: 'Neha', note: '', call: { response: 'Visit Scheduled', nextActionType: 'Call', nextFollowupAt: future(3), note: 'aayega', visitDate: istDay(Date.now() + 2 * 86400000) } };
const n1 = await api('createLeadAndCall', neha, nl, 'req-0000006');
check(n1.success, 'new lead + call + visit');
const n2 = await api('createLeadAndCall', neha, Object.assign({}, nl, { note: 'dobara' }), 'req-0000007');
check(n2.duplicate === true, 'same mobile again -> duplicate, not created');
const n3 = await api('createLead', owner, { mobile: '9000000003', name: 'Pending One', source: 'Walk-in', crm: 'Bhawna' }, 'req-0000008');
check(n3.success, 'owner: lead with call pending (city/product optional)');
check(/active CRM/.test(await apiErr('createLead', owner, { mobile: '9000000004', name: 'X', source: 'Walk-in', crm: 'Old' }, 'req-0000009')), 'inactive CRM rejected');

// ---------- Visits ----------
const vd = await api('getVisitDashboard', neha, today, istDay(Date.now() + 5 * 86400000));
check(vd.items.length === 1 && vd.items[0].status === 'Planned', 'visit planned from call');
const v = vd.items[0];
const vs = await api('saveCustomerVisit', neha, { leadId: v.leadId, visitId: v.id, version: v.version, status: 'Done', date: v.date, note: 'aaya' }, 'req-0000010');
check(vs.success, 'visit marked Done');
const vd2 = await api('getVisitDashboard', neha, today, today);
check(vd2.counts.doneToday === 1, 'arrivals today = 1');

// ---------- Edit lead ----------
const pl = (await api('getCustomerProfile', owner, n1.leadId)).lead;
const ed = await api('updateLead', owner, { leadId: pl.id, knownRowVersion: pl.rowVersion, mobile: pl.mobile, name: 'Shyam Garments', city: 'Agra', source: 'Reference', product: 'Jeans', crm: 'Bhawna', note: '' }, 'req-0000011');
check(ed.success, 'owner edits + reassigns');
check(/Not authorized/.test(await apiErr('getCustomerProfile', neha, pl.id)), 'Neha can no longer open a reassigned customer');

// ---------- Owner screens ----------
const scr = await api('getCrmScreenData', owner, 'owner', today, today);
check(!scr.report.loadError && scr.report.totals.records >= 3, 'owner call report: ' + scr.report.totals.records + ' records today');
const od = await api('getOwnerDashboard', owner, '');
check(od.kpis.callsDoneToday === 3 && od.team.includes('Neha'), 'owner dashboard counts: ' + od.kpis.callsDoneToday);
const qd = await api('getMyQueueDetails', neha, 'done', 0, 25);
check(qd.total === 3 && qd.restrictedCount === 1, 'called-today list hides reassigned customer');
const xl = await api('getDashboardExcelData', owner, today, today, today, today);
check(xl.calls.items.length === 3 && xl.dashboard.queue.length === 4, 'Excel data complete');
check((await api('searchCustomers', neha, 'aman')).leads.length === 1, 'search');

// ---------- Users ----------
const cu = await api('adminCreateCrmUser', owner, { username: 'dimpy.k', displayName: 'Dimpy K', password: 'abcdefgh' });
check(cu.success, 'owner creates CRM user');
const dt = (await call('login', { args: ['dimpy.k', 'abcdefgh'] })).result.token;
check(!!dt, 'new user can log in');
await api('adminRemoveCrmAccess', owner, 'dimpy.k');
check(await apiErr('getMyCallsData', dt) === 'SESSION_EXPIRED', 'removed user is logged out at once');
check(!(await api('getBootstrapData', owner)).team.includes('Dimpy K'), 'removed member gone from team');

// ---------- Legacy ----------
const csv = 'Customer Name,Mobile,Response,Call Date\r\nSonu Mittal,7456997801,Not responding,27-Oct-2026\r\nUday,9106045787,Will visit,2026-10-26\r\nAman again,9810000001,x,2026-10-01\r\nBad,12,y,\r\n';
const an = await api('analyzeBulkUpload', owner, csv);
check(an.uniqueMobiles === 3 && an.invalidMobiles === 1, 'bulk upload analyzed');
const ap = await api('approveBulkUpload', owner, an.batchId);
check(ap.added === 2 && ap.skippedExisting === 1, 'approve: 2 added, 1 already live: ' + JSON.stringify(ap));
const ap2 = await api('approveBulkUpload', owner, an.batchId);
check(ap2.added === 2, 'approve again: same result, nothing doubled');
const lp = await api('getLegacyPage', neha, 0, 20);
check(lp.total === 2, 'legacy queue: 2 pending');
const sonu = lp.items.find(x => x.name === 'Sonu Mittal');
const rs = await api('resolveLegacyRecord', neha, sonu.id, 'active', 'req-0000012');
check(rs.success && rs.lead && rs.lead.crm === 'Neha' && rs.lead.source === 'Legacy Import', 'CALL NOW creates lead for Neha');
const rs2 = await api('resolveLegacyRecord', neha, sonu.id, 'active', 'req-0000013');
check(rs2.lead && rs2.lead.id === rs.lead.id, 'CALL NOW twice: same lead, no duplicate');
const lsave = await api('saveLegacyDetailsAndCall', neha, { leadId: rs.lead.id, knownRowVersion: rs.lead.rowVersion, mobile: '7456997801', name: 'Sonu Mittal', city: 'Bulandshahr', source: 'Legacy Import', product: 'Jeans', crm: 'Neha', note: '', call: { response: 'Interested', nextActionType: 'Call', nextFollowupAt: future(1), note: '' } }, 'req-0000014');
check(lsave.success, 'legacy details + call saved');
check((await api('getLegacyPage', neha, 0, 20)).total === 1, 'legacy queue now 1');

// ---------- Sheet <-> App ----------
const ex = await sync({ op: 'export', table: 'Leads', offset: 0, limit: 500 });
check(ex.ok && ex.total === 5 && ex.headers[0] === 'ID', 'export Leads for the Sheet: ' + ex.total);
const lh = ex.headers, aman = ex.rows.find(r => r[1] === 'Aman Traders').slice();
aman[lh.indexOf('City')] = 'New Delhi';
const re = await sync({ op: 'row', table: 'Leads', headers: lh, row: aman, user: 'anshul' });
check(re.ok && re.updated.includes('City'), 'Sheet edit -> app: ' + re.message);
check((await api('getCustomerProfile', owner, 'L1')).lead.city === 'New Delhi', 'app shows the Sheet edit');
const newRow = lh.map(h => ({ Name: 'Sheet Wala', Mobile: '9999988888', CRM: 'Neha', City: 'Jaipur' }[h] || ''));
const add = await sync({ op: 'row', table: 'Leads', headers: lh, row: newRow, user: 'anshul' });
check(add.ok && add.created && add.key, 'new row typed in Sheet -> new customer in app');
const badRow = lh.map(h => ({ Name: 'X', Mobile: '9810000002' }[h] || ''));
check(!(await sync({ op: 'row', table: 'Leads', headers: lh, row: badRow })).ok, 'Sheet row with existing mobile refused with a message');
const tEx = await sync({ op: 'export', table: 'Team' });
const teamRow = tEx.rows.find(r => r[0] === 'Bhawna'); teamRow[1] = false;
await sync({ op: 'row', table: 'Team', headers: tEx.headers, row: teamRow });
check(!(await api('getBootstrapData', owner)).team.includes('Bhawna'), 'Team Active=FALSE in Sheet -> removed in app');

console.log(`\n${ok} ok, ${bad} failed` + (BASE ? ' (real Cloudflare runtime)' : ` | DB queries: ${env.DB.queries}, transactions: ${env.DB.batches}`));
process.exit(bad ? 1 : 0);
