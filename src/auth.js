// Smart CRM — login, sessions and user administration.
// Passwords use the SAME hash as the Apps Script version, so existing
// usernames and passwords keep working after the move.
import { all, first, run, stmt, insertStmt, updateStmt, auditStmt } from './db.js';
import { sha256Hex, fail, uuid } from './util.js';

const SESSION_TTL_SEC = 21600;     // 6 hours, same as before
const MAX_FAILURES = 10;
const FAILURE_WINDOW_SEC = 900;    // 15 minutes

const userFromRow = r => r && ({
  username: String(r.Username || '').trim(),
  passwordHash: String(r.PasswordHash || ''),
  salt: String(r.Salt || ''),
  displayName: String(r.DisplayName || ''),
  role: String(r.Role || ''),
  teamMemberName: String(r.TeamMemberName || ''),
  active: Number(r.Active) === 1
});
export const publicSession = u => ({ username: u.username, displayName: u.displayName, role: u.role, teamMemberName: u.teamMemberName });
const validRole = r => r === 'Owner' || r === 'CRM';

/** Same fingerprint as Apps Script: password / role / CRM change ends old sessions. */
export function fingerprint(u) {
  return sha256Hex(JSON.stringify([u.username, u.passwordHash, u.salt, u.role, u.teamMemberName, u.active]), 'smart-crm-account-state-v1');
}

export async function activeTeam(db) {
  const rows = await all(db, 'SELECT Name FROM Team WHERE Active=1 ORDER BY rowid');
  return [...new Set(rows.map(r => String(r.Name || '')).filter(Boolean))];
}

export async function login(env, username, password) {
  const db = env.DB;
  username = String(username || '').trim();
  if (!username || typeof password !== 'string' || !password) fail('Enter username and password.');
  const now = Date.now();
  const key = 'fail_' + await sha256Hex(username, 'smart-crm-login-attempts');
  const att = await first(db, 'SELECT Count, Until FROM LoginAttempts WHERE Key=?', key);
  const attempts = att && Number(att.Until) > now ? { count: Number(att.Count), until: Number(att.Until) } : null;
  if (attempts && attempts.count >= MAX_FAILURES) {
    fail('Too many failed login attempts. Try again in ' + Math.max(1, Math.ceil((attempts.until - now) / 60000)) + ' minute(s).');
  }
  const rows = await all(db, 'SELECT * FROM Users WHERE Username=?', username);
  if (rows.length > 1) fail('Duplicate username found in Users sheet. Ask the owner to correct the duplicate.');
  const user = userFromRow(rows[0]);
  const ok = !!(user && user.active && user.passwordHash && user.salt && await sha256Hex(password, user.salt) === user.passwordHash);
  if (!ok) {
    const until = attempts ? attempts.until : now + FAILURE_WINDOW_SEC * 1000;
    await run(db, 'INSERT INTO LoginAttempts (Key, Count, Until) VALUES (?,?,?) ON CONFLICT(Key) DO UPDATE SET Count=?, Until=?',
      key, (attempts ? attempts.count : 0) + 1, until, (attempts ? attempts.count : 0) + 1, until);
    fail('Invalid username or password.');
  }
  if (!validRole(user.role)) fail('Your account role is invalid. Ask the owner to correct it.');
  if (user.role === 'CRM') {
    const team = await activeTeam(db);
    if (!user.teamMemberName || !team.includes(user.teamMemberName)) {
      fail('Your login is not linked to an active team member. Ask the owner to check Users and Team.');
    }
  }
  const token = uuid();
  await db.batch([
    insertStmt(db, 'Sessions', { Token: token, Username: user.username, Fingerprint: await fingerprint(user), ExpiresAt: now + SESSION_TTL_SEC * 1000 }),
    stmt(db, 'DELETE FROM LoginAttempts WHERE Key=?', key),
    stmt(db, 'DELETE FROM Sessions WHERE ExpiresAt < ?', now),
    auditStmt(db, user.username, 'LOGIN', 'User', user.username, '')
  ]);
  return { token, session: publicSession(user) };
}

export async function logout(env, token) {
  if (typeof token === 'string' && token) await run(env.DB, 'DELETE FROM Sessions WHERE Token=?', token);
  return true;
}

/** Checks the session on every request (account status read fresh). */
export async function requireSession(env, token) {
  const db = env.DB;
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token)) fail('SESSION_EXPIRED');
  const s = await first(db, 'SELECT s.Fingerprint AS Fp, s.ExpiresAt AS Exp, u.* FROM Sessions s LEFT JOIN Users u ON u.Username=s.Username WHERE s.Token=?', token);
  const expire = async () => { await run(db, 'DELETE FROM Sessions WHERE Token=?', token); fail('SESSION_EXPIRED'); };
  if (!s) fail('SESSION_EXPIRED');
  if (Date.now() >= Number(s.Exp) || !s.Username) return expire();
  const user = userFromRow(s);
  if (!user.active || !validRole(user.role) || await fingerprint(user) !== s.Fp) return expire();
  if (user.role === 'CRM') {
    const team = await activeTeam(db);
    if (!user.teamMemberName || !team.includes(user.teamMemberName)) return expire();
  }
  return publicSession(user);
}
export function requireOwner(s) { if (!s || s.role !== 'Owner') fail('Not authorized for this action.'); }

/* ---------------- Manage Users (owner) ---------------- */

export async function adminListUsers(env, session) {
  requireOwner(session);
  const rows = await all(env.DB, 'SELECT * FROM Users ORDER BY rowid');
  return rows.map(userFromRow).map(u => ({ username: u.username, displayName: u.displayName, role: u.role, teamMemberName: u.teamMemberName, active: u.active }));
}

export async function adminCreateCrmUser(env, session, payload) {
  requireOwner(session);
  const db = env.DB, p = payload || {};
  const username = String(p.username || '').trim().toLowerCase(), name = String(p.displayName || '').trim(), password = p.password;
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) fail('Login ID: 3–50 letters, numbers, dot, underscore or hyphen.');
  if (!name || name.length > 100 || /^[=+@-]/.test(name)) fail('Enter a valid employee name (maximum 100 characters).');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('Password must be 8–128 characters.');
  const users = (await all(db, 'SELECT * FROM Users')).map(userFromRow);
  const team = await all(db, 'SELECT Name, Active FROM Team');
  const teamMatches = team.filter(t => String(t.Name || '').toLowerCase() === name.toLowerCase());
  const existing = users.filter(u => u.username.toLowerCase() === username);
  if (existing.length) {
    // Retry after a partial create: allow only the exact same account again.
    const old = existing[0];
    if (existing.length !== 1 || !old.active || old.role !== 'CRM' || old.displayName !== name || old.teamMemberName !== name ||
      await sha256Hex(password, old.salt) !== old.passwordHash) fail('Login ID already exists. Choose a different ID.');
    if (teamMatches.length > 1 || teamMatches.some(t => String(t.Name) !== name || Number(t.Active) !== 1)) fail('Team entry needs owner review.');
    if (!teamMatches.length) await run(db, 'INSERT INTO Team (Name, Active) VALUES (?,1)', name);
    return { success: true, username, message: 'User is ready. Login ID: ' + username };
  }
  if (teamMatches.length || users.some(u => u.teamMemberName.toLowerCase() === name.toLowerCase())) {
    fail('This CRM name already exists. Use a unique employee name, for example name + surname.');
  }
  const salt = uuid();
  await db.batch([
    insertStmt(db, 'Users', { Username: username, PasswordHash: await sha256Hex(password, salt), Salt: salt, DisplayName: name, Role: 'CRM', TeamMemberName: name, Active: 1 }),
    insertStmt(db, 'Team', { Name: name, Active: 1 }),
    auditStmt(db, session.username, 'CREATE_CRM_USER', 'User', username, { displayName: name })
  ]);
  return { success: true, username, message: 'User created. Login ID: ' + username };
}

export async function adminRemoveCrmAccess(env, session, username) {
  requireOwner(session);
  const db = env.DB;
  const users = (await all(db, 'SELECT * FROM Users')).map(userFromRow);
  const matches = users.filter(u => u.username === String(username || ''));
  if (matches.length !== 1) fail('User not found or duplicate username. Refresh the list.');
  const user = matches[0];
  if (user.role !== 'CRM' || user.username === session.username) fail('Only CRM employee access can be removed here. Owner accounts are protected.');
  const list = [updateStmt(db, 'Users', { Active: 0 }, 'Username=?', user.username), stmt(db, 'DELETE FROM Sessions WHERE Username=?', user.username)];
  // Keep all customers and history. Stop future assignment to this team member.
  if (user.teamMemberName && !users.some(u => u.username !== user.username && u.active && u.teamMemberName === user.teamMemberName)) {
    list.push(updateStmt(db, 'Team', { Active: 0 }, 'Name=?', user.teamMemberName));
  }
  if (user.active) list.push(auditStmt(db, session.username, 'REMOVE_CRM_ACCESS', 'User', user.username, { teamMemberName: user.teamMemberName }));
  await db.batch(list);
  return { success: true, message: 'Access removed. Existing customers and call history are preserved. Pending customers can be reassigned from Edit Lead.' };
}
