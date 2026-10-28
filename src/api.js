// Smart CRM — API router. The browser calls POST /api/<functionName> with
// { token, args } — the same function names the Apps Script version used.
import * as auth from './auth.js';
import * as crm from './crm.js';
import * as legacy from './legacy.js';
import { syncApi } from './sync.js';
import { UserError } from './util.js';
import { SCHEMA_STATEMENTS } from './schema.js';

/** Creates any missing tables once per server start (safe, never deletes data). */
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) schemaReady = db.batch(SCHEMA_STATEMENTS.map(sql => db.prepare(sql))).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

const WITH_SESSION = {
  getBootstrapData: crm.getBootstrapData,
  getMyQueueSummary: crm.getMyQueueSummary,
  getNextLead: crm.getNextLead,
  getMyCallsData: crm.getMyCallsData,
  getOwnerDashboard: crm.getOwnerDashboard,
  checkDuplicateMobile: crm.checkDuplicateMobile,
  getCustomerProfile: crm.getCustomerProfile,
  searchCustomers: crm.searchCustomers,
  resetCaches: crm.resetCaches,
  getMyQueueDetails: crm.getMyQueueDetails,
  getOwnerCallReport: crm.getOwnerCallReport,
  getVisitDashboard: crm.getVisitDashboard,
  getCrmScreenData: crm.getCrmScreenData,
  getDashboardExcelData: crm.getDashboardExcelData,
  createLead: crm.createLead,
  createLeadAndCall: crm.createLeadAndCall,
  updateLead: crm.updateLead,
  saveCallOutcome: crm.saveCallOutcome,
  saveLegacyDetailsAndCall: crm.saveLegacyDetailsAndCall,
  saveCustomerVisit: crm.saveCustomerVisit,
  analyzeBulkUpload: legacy.analyzeBulkUpload,
  approveBulkUpload: legacy.approveBulkUpload,
  getLegacyQueue: legacy.getLegacyQueue,
  getLegacyPage: legacy.getLegacyPage,
  resolveLegacyRecord: legacy.resolveLegacyRecord,
  adminListUsers: auth.adminListUsers,
  adminCreateCrmUser: auth.adminCreateCrmUser,
  adminRemoveCrmAccess: auth.adminRemoveCrmAccess
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export async function handle(request, env, name) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
  if (!env.DB) return json({ ok: false, error: 'Database is not connected. In Cloudflare: Settings > Bindings > add D1 database as DB.' }, 500);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Bad request.' }, 400); }
  try {
    await ensureSchema(env.DB);
    let result;
    if (name === 'sync') result = await syncApi(env, body || {});
    else if (name === 'login') result = await auth.login(env, ...(body.args || []));
    else if (name === 'logout') result = await auth.logout(env, ...(body.args || []));
    else if (Object.prototype.hasOwnProperty.call(WITH_SESSION, name)) {
      const session = await auth.requireSession(env, body.token);
      result = await WITH_SESSION[name](env, session, ...(Array.isArray(body.args) ? body.args : []));
    } else return json({ ok: false, error: 'Unknown action: ' + name }, 404);
    return json({ ok: true, result: result === undefined ? null : result });
  } catch (e) {
    const known = e instanceof UserError;
    if (!known) console.error(name, e && e.stack || e);
    // Unknown server errors: plain message; data is never half-saved (each save is one transaction).
    return json({ ok: false, error: known ? e.message : 'Server error: ' + String(e && e.message || e).slice(0, 300) }, known ? 200 : 500);
  }
}
