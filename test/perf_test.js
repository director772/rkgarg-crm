import { D1Shim } from './d1shim.js';
import { handle } from '../src/api.js';
import { sha256Hex } from '../src/util.js';
const env = { DB: new D1Shim(new URL('../schema.sql', import.meta.url).pathname), SYNC_KEY: 'test-sync-key-1234567890' };
const call = async (n, b) => (await handle(new Request('https://x/api/' + n, { method: 'POST', body: JSON.stringify(b) }), env, n)).json();
const db = env.DB.db;
db.exec('BEGIN');
const ins = db.prepare('INSERT INTO Leads (ID,Name,Mobile,City,Source,Product,CRM,Status,Disposition,Score,LastCallAt,NextActionType,NextFollowupAt,Note,CreatedAt,RowVersion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)');
const crms = ['Neha', 'Bhawna', 'Dimpy', 'Ravi', 'Sonu'];
for (let i = 0; i < 2000; i++) ins.run('L' + i, 'Customer ' + i, String(9000000000 + i), 'City', 'WhatsApp', 'Jeans', crms[i % 5], i % 3 ? 'callback' : 'fresh', 'Call Later', 8, i % 3 ? new Date(Date.now() - 86400000).toISOString() : '', 'Call', i % 3 ? new Date(Date.now() + (i % 7 - 3) * 86400000).toISOString() : '', 'Note text for customer ' + i, new Date(Date.now() - i * 60000).toISOString());
const ic = db.prepare('INSERT INTO CallLog (ID,LeadID,CallDate,Response,Note,CreatedBy,CRM) VALUES (?,?,?,?,?,?,?)');
for (let i = 0; i < 10000; i++) ic.run('C' + i, 'L' + (i % 2000), new Date(Date.now() - (i % 60) * 86400000 / 2).toISOString(), i % 4 ? 'Not Picked' : 'Visit Scheduled', 'call note ' + i, 'neha', crms[i % 5]);
db.prepare("INSERT INTO Users VALUES ('owner',?, 's','Owner','Owner','',1)").run(await sha256Hex('pass1234', 's'));
db.prepare("INSERT INTO Users VALUES ('neha',?, 's','Neha','CRM','Neha',1)").run(await sha256Hex('pass1234', 's'));
crms.forEach(c => db.prepare('INSERT INTO Team VALUES (?,1)').run(c));
db.exec('COMMIT');
const own = (await call('login', { args: ['owner', 'pass1234'] })).result.token, neha = (await call('login', { args: ['neha', 'pass1234'] })).result.token;
const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const tests = [['getMyCallsData', neha, []], ['getOwnerDashboard', own, ['']], ['getCrmScreenData', own, ['owner', today, today]], ['getVisitDashboard', neha, [today, today]], ['getMyQueueDetails', neha, ['overdue', 0, 25]], ['searchCustomers', own, ['customer 19']]];
for (const [n, t, a] of tests) {
  // CPU = JS work only: run with an already-loaded result cache impossible here, so report total and SQL share.
  const t0 = performance.now(); const r = await call(n, { token: t, args: a }); const ms = performance.now() - t0;
  console.log(n.padEnd(22), (r.ok ? 'ok ' : 'ERR ' + r.error).padEnd(5), ms.toFixed(1) + ' ms total (includes local SQLite)');
}
