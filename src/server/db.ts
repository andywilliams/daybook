import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.cwd(), 'data/daybook.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

migrate(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('done','plan','note','blocker')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entries_kind_created
    ON entries(kind, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_entries_created
    ON entries(created_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    content,
    content='entries',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content) VALUES('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO entries_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);

export type Kind = 'done' | 'plan' | 'note' | 'blocker';
export type Status = 'open' | 'resolved';

export interface Entry {
  id: number;
  kind: Kind;
  content: string;
  status: Status;
  created_at: string;
  updated_at: string;
}

function migrate(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'")
    .get() as { sql: string } | undefined;
  if (!row) return; // fresh DB; CREATE TABLE below will use the new schema
  if (row.sql.includes("'plan'")) return; // already migrated

  // Old schema lacks 'plan' in the CHECK constraint. Rebuild the table while
  // preserving rows; FTS + triggers + indexes are dropped and recreated by the
  // unconditional block below.
  db.exec(`
    BEGIN;
    DROP TRIGGER IF EXISTS entries_ai;
    DROP TRIGGER IF EXISTS entries_ad;
    DROP TRIGGER IF EXISTS entries_au;
    DROP TABLE IF EXISTS entries_fts;

    CREATE TABLE entries_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('done','plan','note','blocker')),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO entries_new (id, kind, content, status, created_at, updated_at)
      SELECT id, kind, content, status, created_at, updated_at FROM entries;
    DROP TABLE entries;
    ALTER TABLE entries_new RENAME TO entries;
    COMMIT;
  `);
}

// After the FTS table is (re)created above, populate it from existing rows if
// it's empty. This handles two cases:
//   - a migration just dropped + recreated FTS
//   - the user upgraded daybook and the FTS table didn't exist on the old DB
const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM entries_fts').get() as { n: number };
if (ftsCount.n === 0) {
  const entryCount = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
  if (entryCount.n > 0) {
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild');");
  }
}
