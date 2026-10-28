// New customers are shared by all CRMs; the first CRM to call gets the customer.
import { D1Shim } from './d1shim.js';
import { handle } from '../src/api.js';
import { sha256Hex } from '../src/util.js';

const env = { DB: new D1Shim(new URL('../schema.sql', import.meta.url).pathname), SYNC_KEY: 'test-sync-key-1234567890' };
let ok = 0, bad = 0;
const check = (c, m) => { if (c) { ok++; console.log('ok -', m); } else { bad++; console.log('FAIL -', m); } };
async function call(name, body) {
  const res = await handle(new Request('https://x/api/' + name, { method: 'POST', body: JSON.stringify(body) }), env, name);
  return res.json();
}
const api = async (name, token, ...args) => { const r = await call(name, { token, args }); if (!r.ok) throw new Error(r.error); return r.result; };
const apiErr = async (name, token, ...args) => { const r = await call(name, { token, args }); return r.ok ? null : r.error; };
const sync = async body => (await call('sync', Object.assign({ key: env.SYNC_KEY }, body))).result;
const future = days => new Date(Date.now() + days * 86400000).toISOString();
const sql = (q, ...a) => env.DB.db.prepare(q).all(...a);

const users = [];
for (const [u, role, team] of [['owner', 'Owner', ''], ['neha', 'CRM', 'Neha'], ['bhawna', 'CRM', 'Bhawna'], ['dimpy', 'CRM', 'Dimpy']]) {
  users.push([u, await sha256Hex('pass1234', 's-' + u), 's-' + u, u, role, team, true]);
}
await sync({ op: 'append', table: 'Users', headers: ['Username', 'PasswordHash', 'Salt', 'DisplayName', 'Role', 'TeamMemberName', 'Active'], rows: users });
await sync({ op: 'append', table: 'Team', headers: ['Name', 'Active'], rows: [['Neha', true], ['Bhawna', true], ['Dimpy', true]] });
const H = ['ID', 'Name', 'Mobile', 'City', 'Source', 'Product', 'CRM', 'Status', 'Disposition', 'Score', 'LastCallAt', 'NextActionType', 'NextFollowupAt', 'Note', 'CreatedAt', 'CreatedBy', 'LastUpdatedAt', 'LastUpdatedBy', 'RowVersion'];
const rows = [];
// 8 new customers, all given to Neha (e.g. one ad campaign).
for (let i = 1; i <= 8; i++) rows.push(['N' + i, 'New ' + i, '98200000' + String(i).padStart(2, '0'), 'Delhi', 'Meta Ad', 'Jeans', 'Neha', 'fresh', 'Yet To Call', 8, '', 'Call', '', '', '2026-10-0' + i + 'T05:00:00.000Z', 'owner', '', '', 1]);
// Neha's own follow-up (already called) — stays private to Neha.
rows.push(['F1', 'Followup Neha', '9820000099', 'Agra', 'WhatsApp', 'Kids', 'Neha', 'callback', 'Call Later', 8, '2026-10-20T05:00:00.000Z', 'Call', '2026-10-21T05:00:00.000Z', '', '2026-10-01T05:00:00.000Z', 'owner', '', '', 2]);
await sync({ op: 'append', table: 'Leads', headers: H, rows });

const login = async u => (await call('login', { args: [u, 'pass1234'] })).result.token;
const [owner, neha, bhawna, dimpy] = [await login('owner'), await login('neha'), await login('bhawna'), await login('dimpy')];

// ---- Everyone sees new customers; nobody gets the same one ----
const [qn, qb, qd] = await Promise.all([api('getMyCallsData', neha), api('getMyCallsData', bhawna), api('getMyCallsData', dimpy)]);
const pool = q => q.queue.filter(l => l.id.startsWith('N')).map(l => l.id);
check(pool(qb).length === 3 && pool(qd).length === 2, 'Bhawna & Dimpy get Neha\'s new customers too: ' + pool(qb) + ' / ' + pool(qd));
const allIds = [...pool(qn), ...pool(qb), ...pool(qd)];
check(new Set(allIds).size === allIds.length, 'no new customer is on two screens at once: ' + allIds.join(','));
check(qn.queue[0].id === 'F1', 'Neha\'s own due follow-up comes first for her');
check(!qb.queue.some(l => l.id === 'F1') && !qd.queue.some(l => l.id === 'F1'), 'follow-ups stay with their own CRM');
check(qb.summary.fresh === 8 && qn.summary.fresh === 8, '"First call pending" count = all new customers for every CRM');
check(qb.lead && qb.lead.id === pool(qb)[0], 'Bhawna\'s screen shows her first held customer');

// ---- Refresh keeps the same customer on screen and does not write again ----
const before = env.DB.batches;
const qb2 = await api('getMyCallsData', bhawna);
check(qb2.lead.id === qb.lead.id && env.DB.batches === before, 'refresh: same customer stays, no extra database write');

// ---- Bhawna calls one of Neha's new customers -> customer becomes Bhawna's ----
const target = qb.lead;
const saved = await api('saveCallOutcome', bhawna, { leadId: target.id, knownRowVersion: target.rowVersion, response: 'Interested', nextActionType: 'Call', nextFollowupAt: future(2), note: 'liked' }, 'req-pool-0001');
check(saved.success, 'Bhawna saved first call on a customer given to Neha');
const lead = sql('SELECT CRM, Status FROM Leads WHERE ID=?', target.id)[0];
check(lead.CRM === 'Bhawna' && lead.Status === 'interested', 'customer now belongs to Bhawna (CRM column updated → Sheet shows Bhawna)');
check(sql('SELECT CRM FROM CallLog WHERE LeadID=?', target.id)[0].CRM === 'Bhawna', 'call counted for Bhawna in reports');
check(sql('SELECT * FROM LeadClaims WHERE LeadID=?', target.id).length === 0, 'hold released after the call');
const audit = JSON.parse(sql("SELECT Details FROM AuditLog WHERE Action='SAVE_CALL' AND EntityID=?", target.id)[0].Details);
check(audit.crmFrom === 'Neha' && audit.crmTo === 'Bhawna', 'audit log records the hand-over Neha → Bhawna');

// ---- Neha can no longer open or save it ----
check(/Not authorized/.test(await apiErr('getCustomerProfile', neha, target.id)), 'Neha cannot open it any more');
const late = await apiErr('saveCallOutcome', neha, { leadId: target.id, knownRowVersion: target.rowVersion, response: 'Interested', nextActionType: 'Call', nextFollowupAt: future(1) }, 'req-pool-0002');
check(/^Ye customer ab Bhawna ke paas hai/.test(late || ''), 'late save by Neha refused with a clear message: ' + late);
const bsum = await api('getMyCallsData', bhawna);
check(bsum.summary.done === 1 && bsum.summary.fresh === 7, 'Bhawna: 1 called today, 7 new left');

// ---- Two CRMs saving the same new customer at the same moment: only one wins ----
const t2 = (await api('getMyCallsData', dimpy)).lead;
const v = { leadId: t2.id, knownRowVersion: t2.rowVersion, response: 'Not Picked', nextActionType: 'Call', nextFollowupAt: future(1) };
const both = await Promise.all([call('saveCallOutcome', { token: dimpy, args: [v, 'req-pool-0003'] }), call('saveCallOutcome', { token: neha, args: [v, 'req-pool-0004'] })]);
const wins = both.filter(r => r.ok && r.result.success).length;
check(wins === 1, 'same customer saved by two CRMs at once → exactly one save: ' + JSON.stringify(both.map(r => r.ok ? r.result.success : r.error)));
check(sql('SELECT COUNT(*) AS n FROM CallLog WHERE LeadID=?', t2.id)[0].n === 1, 'only one call entry written');

// ---- Customer search / duplicate check ----
const sr = await api('searchCustomers', dimpy, 'New ');
check(sr.leads.every(l => l.crm === 'Dimpy' || !l.lastCallAt), 'search shows new customers + own customers only');
check((await api('checkDuplicateMobile', dimpy, '9820000008')).canAccess === true, 'duplicate check: new customer is open to every CRM');
check((await api('checkDuplicateMobile', dimpy, '9820000099')).canAccess === false, 'duplicate check: someone else\'s follow-up stays hidden');

// ---- Hold expires when a CRM goes away ----
const held = sql("SELECT LeadID FROM LeadClaims WHERE CRM='Neha'").map(r => r.LeadID);
env.DB.db.prepare("UPDATE LeadClaims SET Until=1 WHERE CRM='Neha'").run();
const after = new Set(pool(await api('getMyCallsData', bhawna)).concat(pool(await api('getMyCallsData', dimpy))));
check(held.length > 0 && held.some(id => after.has(id)), 'Neha\'s screen closed → her held customers go to others after 15 min');

// ---- Owner new lead message rule: lead given to Neha also shows for Dimpy ----
const nl = await api('createLead', owner, { mobile: '9000000777', name: 'Fresh Owner Lead', source: 'Walk-in', city: 'Delhi', product: 'Jeans', crm: 'Neha' }, 'req-pool-0005');
check((await api('getMyQueueDetails', dimpy, 'fresh', 0, 100)).items.some(l => l.id === nl.leadId), 'new lead added by owner for Neha is in everyone\'s "First call pending" list');

// ---- A CRM leaves the job: owner removes access and gives her customers to Dimpy ----
// Give Neha a pending visit on her follow-up customer.
await api('saveCustomerVisit', neha, { leadId: 'F1', status: 'Planned', date: new Date(Date.now() + 2 * 86400000 + 19800000).toISOString().slice(0, 10), note: 'shop visit' }, 'req-pool-0006');
const nehaOpen = sql("SELECT COUNT(*) AS n FROM Leads WHERE CRM='Neha' AND Status<>'closed'")[0].n;
const listU = await api('adminListUsers', owner);
check(listU.find(u => u.username === 'neha').openCustomers === nehaOpen && nehaOpen > 0, 'Manage Users shows Neha\'s open customers: ' + nehaOpen);
check(/chalu customer hain\. Pehle chuno/.test(await apiErr('adminRemoveCrmAccess', owner, 'neha') || ''), 'cannot remove without choosing who gets the customers');
check(/active CRM/.test(await apiErr('adminRemoveCrmAccess', owner, 'neha', 'Nobody') || ''), 'unknown CRM refused');
const closedBefore = sql("SELECT COUNT(*) AS n FROM Leads WHERE CRM='Neha' AND Status='closed'")[0].n;
const callsBefore = sql("SELECT COUNT(*) AS n FROM CallLog WHERE CRM='Neha'")[0].n;
const rm = await api('adminRemoveCrmAccess', owner, 'neha', 'Dimpy');
check(rm.success && rm.moved === nehaOpen && rm.visits === 1, 'removed: ' + rm.message);
check(await apiErr('getMyCallsData', neha) === 'SESSION_EXPIRED', 'Neha logged out at once');
check(sql("SELECT COUNT(*) AS n FROM Leads WHERE CRM='Neha' AND Status<>'closed'")[0].n === 0, 'no open customer left stuck with Neha');
check(sql("SELECT CRM, NextFollowupAt FROM Leads WHERE ID='F1'")[0].CRM === 'Dimpy' && sql("SELECT NextFollowupAt FROM Leads WHERE ID='F1'")[0].NextFollowupAt === '2026-10-21T05:00:00.000Z', 'follow-up customer moved to Dimpy, follow-up date unchanged');
check(sql("SELECT CRM FROM Visits WHERE LeadID='F1'")[0].CRM === 'Dimpy', 'pending visit moved to Dimpy');
check(sql("SELECT COUNT(*) AS n FROM Leads WHERE CRM='Neha' AND Status='closed'")[0].n === closedBefore, 'closed customers stay as history');
check(sql("SELECT COUNT(*) AS n FROM CallLog WHERE CRM='Neha'")[0].n === callsBefore, 'old call history still shows Neha\'s name');
check(sql("SELECT COUNT(*) AS n FROM LeadClaims WHERE CRM='Neha'")[0].n === 0, 'Neha\'s held new customers freed at once');
const dq = await api('getMyCallsData', dimpy);
check(dq.queue[0].id === 'F1', 'Dimpy\'s My Calls now shows Neha\'s overdue follow-up first');
check(!(await api('getBootstrapData', owner)).team.includes('Neha'), 'Neha removed from CRM list');
const again = await api('adminRemoveCrmAccess', owner, 'neha', 'Dimpy');
check(again.success && again.moved === 0, 'pressing again is safe (nothing moves twice)');

console.log(`\n${ok} ok, ${bad} failed | DB queries: ${env.DB.queries}, transactions: ${env.DB.batches}`);
process.exit(bad ? 1 : 0);
