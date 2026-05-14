import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.cwd(), 'data/daybook.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('done','note','blocker')),
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

export type Kind = 'done' | 'note' | 'blocker';
export type Status = 'open' | 'resolved';

export interface Entry {
  id: number;
  kind: Kind;
  content: string;
  status: Status;
  created_at: string;
  updated_at: string;
}
