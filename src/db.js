// Small D1 helpers.
export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args.map(clean)).all()).results || [];
export const first = (db, sql, ...args) => db.prepare(sql).bind(...args.map(clean)).first();
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args.map(clean)).run();
export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args.map(clean));

function clean(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/** INSERT for an object (keys are column names). */
export function insertStmt(db, table, obj, verb = 'INSERT') {
  const keys = Object.keys(obj);
  return stmt(db, `${verb} INTO ${table} (${keys.map(q).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => obj[k]));
}
/** UPDATE table SET obj WHERE where (where = SQL with ? placeholders). */
export function updateStmt(db, table, obj, where, ...whereArgs) {
  const keys = Object.keys(obj);
  return stmt(db, `UPDATE ${table} SET ${keys.map(k => q(k) + '=?').join(',')} WHERE ${where}`, ...keys.map(k => obj[k]), ...whereArgs);
}
/** Statement that cancels the whole save when the condition SQL is NOT true. */
export function guardStmt(db, conditionSql, ...args) {
  return stmt(db, `INSERT INTO SaveGuard (V) SELECT NULL WHERE NOT (${conditionSql})`, ...args);
}
export const isGuardFailure = e => /SaveGuard/.test(String(e && e.message || e));
export const isUniqueFailure = (e, what) => /UNIQUE constraint failed/.test(String(e && e.message || e)) && (!what || String(e.message).includes(what));
export const q = k => '"' + String(k).replace(/"/g, '') + '"';

/** Audit row statement (same columns as the AuditLog sheet). */
export function auditStmt(db, user, action, entityType, entityId, details, at) {
  return insertStmt(db, 'AuditLog', {
    Timestamp: at || new Date().toISOString(),
    User: user,
    Action: action,
    EntityType: entityType,
    EntityID: String(entityId || ''),
    Details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : ''
  });
}
