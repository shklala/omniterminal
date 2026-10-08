import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

function openChecked(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    const res = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
    if (!res || Object.values(res)[0] !== 'ok') throw new Error(`integrity_check: ${JSON.stringify(res)}`);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function removeDbFiles(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

/**
 * SQLite database using Node's built-in engine (node:sqlite), in WAL mode.
 * Every write is a real, durable SQLite transaction, so a crash can never tear the file.
 * A consistent snapshot is copied to `<file>.bak` (VACUUM INTO) each time the manager starts;
 * an unreadable database is set aside and restored from that backup.
 */
export class Db {
  /** True when the on-disk DB was unreadable and a fresh one was created. */
  recoveredFromCorruption = false;

  private constructor(private readonly db: DatabaseSync, private readonly file: string, private readonly log: Logger) {}

  static async open(file: string, log: Logger): Promise<Db> {
    let db: DatabaseSync | null = null;
    let recovered = false;
    if (fs.existsSync(file)) {
      try {
        db = openChecked(file);
      } catch (e) {
        log.error('Database unreadable; setting it aside', e);
        const aside = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, aside);
        } catch {
          /* fall through: removed below */
        }
        removeDbFiles(file);
        recovered = true;
      }
    }
    if (!db && fs.existsSync(`${file}.bak`)) {
      try {
        fs.copyFileSync(`${file}.bak`, file);
        db = openChecked(file);
        log.warn('Database restored from backup');
        recovered = false;
      } catch (e) {
        log.error('Backup database unreadable too', e);
        removeDbFiles(file);
      }
    }
    const isNew = !db;
    db ??= new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    const inst = new Db(db, file, log);
    inst.recoveredFromCorruption = recovered && isNew;
    inst.migrate();
    inst.backup();
    return inst;
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const row = this.get('SELECT value FROM meta WHERE key = ?', ['schema_version']);
    let version = row ? Number(row.value) : 0;
    while (version < SCHEMA_VERSION) {
      version += 1;
      const v = version;
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(v)]);
      });
    }
  }

  /** Consistent snapshot to <file>.bak, used if the main file is ever damaged. */
  private backup(): void {
    const bak = `${this.file}.bak`;
    const tmp = `${bak}.tmp`;
    try {
      fs.rmSync(tmp, { force: true });
      this.db.prepare('VACUUM INTO ?').run(tmp);
      fs.renameSync(tmp, bak);
    } catch (e) {
      this.log.warn('Could not refresh database backup', e);
      fs.rmSync(tmp, { force: true });
    }
  }

  all(sql: string, params: Param[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  get(sql: string, params: Param[] = []): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  run(sql: string, params: Param[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Folds the WAL into the main file (writes are already durable; this just keeps the file self-contained). */
  flush(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
      this.log.warn('WAL checkpoint failed', e);
    }
  }

  /** False once close() ran (late async callbacks check this before writing). */
  get isOpen(): boolean {
    return this.db.isOpen;
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
