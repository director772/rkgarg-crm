// Smart CRM — shared helpers (time in India, hashing, validation).
// Ported from the Apps Script version so results stay identical.

export const TZ = 'Asia/Kolkata';
const IST_MS = 19800000; // +05:30
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Error shown to the user as-is. */
export class UserError extends Error {}
export const fail = msg => { throw new UserError(msg); };

export function uuid() { return crypto.randomUUID(); }

/** Same algorithm as Apps Script hashPassword_ (SHA-256 of "value::salt", hex). */
export async function sha256Hex(value, salt) {
  const bytes = new TextEncoder().encode(String(value) + '::' + String(salt));
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** ISO string or '' (throws a clear error on an invalid date). */
export function iso(v, label) {
  if (v === '' || v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) fail('Invalid date: ' + label);
  return d.toISOString();
}
const localDate = v => new Date(new Date(v).getTime() + IST_MS);
const pad = n => String(n).padStart(2, '0');

/** "29-Oct-26 01:17 PM" in India time. */
export function fmtDateTime(v) {
  if (!v) return '—';
  const t = new Date(v);
  if (isNaN(t.getTime())) return '—';
  const d = localDate(t), h = d.getUTCHours();
  return pad(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + pad(d.getUTCFullYear() % 100) + ' ' +
    pad(h % 12 || 12) + ':' + pad(d.getUTCMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
}
/** "29-Oct-26" in India time. */
export function fmtDate(v) {
  if (!v) return '—';
  const t = new Date(v);
  if (isNaN(t.getTime())) return '—';
  const d = localDate(t);
  return pad(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + pad(d.getUTCFullYear() % 100);
}
/** "2026-10-29" (India day). */
export function dayKey(v) { return localDate(v).toISOString().slice(0, 10); }

export function text(v, label, max) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > max) fail(label + ' is too long. Maximum ' + max + ' characters.');
  return s;
}
export function normalizeMobile(m) {
  const d = String(m || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
export const isValidMobile = m => /^\d{10}$/.test(m);

export function reportDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(label + ' must be a valid date.');
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value || Number(value.slice(0, 4)) < 1970) fail(label + ' must be a valid date.');
  return d;
}
export function validRequestId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(id)) fail('Missing or invalid request ID. Refresh the app and retry.');
}
/** Stable JSON (sorted keys) so the same input always gives the same fingerprint. */
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
