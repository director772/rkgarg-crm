// Local stand-in for Cloudflare D1 (same API shape) on Node's built-in SQLite.
// Used only for tests on this machine; the real app uses Cloudflare D1.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

class Bound {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args; }
  _stmt() { return this.db.prepare(this.sql); }
  _args() {
    return this.args.map(v => {
      if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined bound in ' + this.sql);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
  }
  async all() { return { results: this._stmt().all(...this._args()).map(r => ({ ...r })) }; }
  async first(col) {
    const r = this._stmt().get(...this._args());
    if (!r) return null;
    return col ? r[col] : { ...r };
  }
  async run() { const r = this._stmt().run(...this._args()); return { meta: { changes: Number(r.changes) } }; }
  _runSync() { const r = this._stmt().run(...this._args()); return { meta: { changes: Number(r.changes) } }; }
}
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; }
  bind(...args) { return new Bound(this.db, this.sql, args); }
  all() { return this.bind().all(); }
  first(c) { return this.bind().first(c); }
  run() { return this.bind().run(); }
}
export class D1Shim {
  constructor(schemaFile) {
    this.db = new DatabaseSync(':memory:');
    if (schemaFile) this.db.exec(fs.readFileSync(schemaFile, 'utf8'));
    this.queries = 0;
    this.batches = 0;
  }
  prepare(sql) { this.queries++; return new Stmt(this.db, sql); }
  async batch(list) {
    this.batches++;
    this.db.exec('BEGIN');
    try {
      const out = list.map(b => (b instanceof Stmt ? b.bind() : b)._runSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) { this.db.exec(sql); }
}
