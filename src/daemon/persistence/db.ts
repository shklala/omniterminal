import * as fs from 'node:fs';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { writeFileAtomic } from '../fsutil';
import type { Logger } from '../log';

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      pid INTEGER,
      pid_start TEXT,
      daemon_pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ui_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
};

export type Row = Record<string, string | number | null | Uint8Array>;
export type Param = string | number | null;

let sqlPromise: Promise<SqlJsStatic> | null = null;
function loadSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs();
  return sqlPromise;
}

/**
 * SQLite (sql.js / WASM) database persisted to a single file.
 * Writes are debounced and flushed atomically (temp + rename) with a rolling .bak copy,
 * so a crash can never leave a torn database file.
 */
export class Db {
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  /** True when the on-disk DB was unreadable and a fresh one was created. */
  recoveredFromCorruption = false;

  private constructor(private readonly db: Database, private readonly file: string, private readonly log: Logger) {}

  static async open(file: string, log: Logger): Promise<Db> {
    const SQL = await loadSql();
    let db: Database | null = null;
    let recovered = false;
    for (const candidate of [file, `${file}.bak`]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const d = new SQL.Database(fs.readFileSync(candidate));
        d.exec('PRAGMA integrity_check');
        d.exec('SELECT count(*) FROM sqlite_master');
        db = d;
        if (candidate !== file) {
          log.warn('Primary database unreadable; restored from backup');
          recovered = true;
        }
        break;
      } catch (e) {
        log.error(`Database file unreadable: ${candidate}`, e);
        recovered = true;
      }
    }
    const isNew = !db;
    db ??= new SQL.Database();
    const inst = new Db(db, file, log);
    inst.recoveredFromCorruption = recovered && isNew;
    inst.migrate();
    inst.flush();
    return inst;
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const row = this.get('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    let version = row ? Number(row.value) : 0;
    while (version < SCHEMA_VERSION) {
      version += 1;
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(version)]);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    this.markDirty();
  }

  all(sql: string, params: Param[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql: string, params: Param[] = []): Row | undefined {
    return this.all(sql, params)[0];
  }

  run(sql: string, params: Param[] = []): void {
    this.db.run(sql, params);
    this.markDirty();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      this.markDirty();
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 150);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty && fs.existsSync(this.file)) return;
    const data = this.db.export();
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    } catch (e) {
      this.log.warn('Could not refresh database backup', e);
    }
    writeFileAtomic(this.file, data);
    this.dirty = false;
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
