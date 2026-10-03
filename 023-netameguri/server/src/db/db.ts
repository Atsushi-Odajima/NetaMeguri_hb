import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Row = Record<string, any>;

/**
 * Thin wrapper over node:sqlite. All SQL uses bound parameters (no string interpolation of user input).
 * The repository layer is intentionally small so that a Postgres implementation can replace it (see DECISIONS.md).
 */
export class DB {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA_SQL);
    this.raw.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('schemaVersion', String(SCHEMA_VERSION));
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.stmt(sql).all(...params.map(bind)) as T[];
  }
  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.stmt(sql).get(...params.map(bind)) as T | undefined;
  }
  run(sql: string, ...params: any[]) {
    return this.stmt(sql).run(...params.map(bind));
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  /** Insert a row object into table (keys are trusted column names from code, never user input). */
  insert(table: string, row: Row) {
    const keys = Object.keys(row);
    assertIdent(table);
    keys.forEach(assertIdent);
    this.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  }

  update(table: string, id: string, workspaceId: string, patch: Row) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    assertIdent(table);
    keys.forEach(assertIdent);
    this.run(
      `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND workspace_id = ?`,
      ...keys.map((k) => patch[k]),
      id,
      workspaceId,
    );
  }

  close() {
    this.raw.close();
  }
}

function assertIdent(s: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('invalid identifier');
}

function bind(v: any) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function j<T = any>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
