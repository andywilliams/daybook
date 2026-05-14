/**
 * Imports tix-kanban data into daybook.
 *
 *   tsx scripts/import-tix-kanban.ts [--source=<dir>] [--user-data=<dir>]
 *                                    [--include-tasks] [--dry-run]
 *
 *   --source       Path to the tix-kanban project (contains data/standups/).
 *                  Default: ../tix-kanban
 *   --user-data    Path to the tix-kanban user dir (contains tasks/).
 *                  Default: $HOME/.tix-kanban
 *   --include-tasks  Also import kanban tasks (off by default).
 *   --dry-run      Show what would be imported; don't write anything.
 *
 * Mappings:
 *   standup yesterday[]  -> done entry on (standup.date - 1 day)
 *   standup today[]      -> plan entry on standup.date
 *   standup blockers[]   -> blocker entry on standup.date (status=resolved)
 *   task done|verified   -> done entry on task.updatedAt
 *   task in-progress|review|auto-review -> plan entry (open) on task.createdAt
 *   task backlog         -> skipped
 *
 * Idempotent: re-running skips entries that already exist on the same day
 * with the same kind+content.
 */

import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface StandupJSON {
  date?: string;
  yesterday?: string[];
  today?: string[];
  blockers?: string[];
}

interface TaskJSON {
  id?: string;
  title?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

type Kind = 'done' | 'plan' | 'note' | 'blocker';
type Status = 'open' | 'resolved';

interface ImportRow {
  kind: Kind;
  content: string;
  day: string; // YYYY-MM-DD
  hour: number; // 0-23 in UTC, used to order rows from the same day
  status: Status;
  source: string; // for the dry-run log
}

// --- args ---

interface Args {
  source: string;
  userData: string;
  includeTasks: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: resolve(process.cwd(), '../tix-kanban'),
    userData: join(homedir(), '.tix-kanban'),
    includeTasks: false,
    dryRun: false,
  };
  for (const a of argv) {
    if (a.startsWith('--source=')) args.source = resolve(a.slice('--source='.length));
    else if (a.startsWith('--user-data=')) args.userData = resolve(a.slice('--user-data='.length));
    else if (a === '--include-tasks') args.includeTasks = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(__usage());
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      console.error(__usage());
      process.exit(2);
    }
  }
  return args;
}

function __usage(): string {
  return [
    'Usage: tsx scripts/import-tix-kanban.ts [options]',
    '',
    '  --source=<dir>       tix-kanban project root (has data/standups/)',
    '  --user-data=<dir>    tix-kanban user dir (has tasks/)',
    '  --include-tasks      Also import kanban tasks',
    '  --dry-run            Preview without writing',
  ].join('\n');
}

// --- placeholders & helpers ---

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^no\s+(git|github|activity|commits|prs|tickets)/i,
  /^none\s+at\s+this\s+time$/i,
  /^none$/i,
  /^n\/?a$/i,
  /^-+$/,
  /^planning\s+and\s+prioritizing\s+tasks\s+for\s+today$/i,
];

function isPlaceholder(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(t));
}

function toDay(input: string | undefined | null): string | null {
  if (!input) return null;
  // Accepts ISO timestamps, "YYYY-MM-DD", or "YYYY-MM-DD HH:MM:SS"
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function tsAt(day: string, hour: number): string {
  // SQLite "YYYY-MM-DD HH:MM:SS" UTC
  const hh = String(hour).padStart(2, '0');
  return `${day} ${hh}:00:00`;
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFiles<T>(dir: string): Array<{ path: string; data: T }> {
  if (!dirExists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = join(dir, f);
      try {
        return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) as T };
      } catch (err) {
        console.warn(`  ! could not read ${p}: ${(err as Error).message}`);
        return null;
      }
    })
    .filter((x): x is { path: string; data: T } => x !== null);
}

// --- collectors ---

function collectStandups(sourceDir: string): ImportRow[] {
  const dir = join(sourceDir, 'data', 'standups');
  const files = readJsonFiles<StandupJSON>(dir);
  if (files.length === 0) {
    console.log(`No standups found in ${dir}`);
    return [];
  }
  console.log(`Reading ${files.length} standup file(s) from ${dir}`);
  const rows: ImportRow[] = [];
  for (const { path, data } of files) {
    const day = toDay(data.date);
    if (!day) {
      console.warn(`  ! skipping ${path}: no usable date`);
      continue;
    }
    for (const item of data.yesterday ?? []) {
      if (isPlaceholder(item)) continue;
      rows.push({
        kind: 'done',
        content: item.trim(),
        day: shiftDay(day, -1),
        hour: 17,
        status: 'open',
        source: `standup ${day} (yesterday)`,
      });
    }
    for (const item of data.today ?? []) {
      if (isPlaceholder(item)) continue;
      rows.push({
        kind: 'plan',
        content: item.trim(),
        day,
        hour: 9,
        status: 'open',
        source: `standup ${day} (today)`,
      });
    }
    for (const item of data.blockers ?? []) {
      if (isPlaceholder(item)) continue;
      rows.push({
        kind: 'blocker',
        content: item.trim(),
        day,
        hour: 10,
        status: 'resolved', // historical — don't clutter open blockers
        source: `standup ${day} (blocker)`,
      });
    }
  }
  return rows;
}

function collectTasks(userDataDir: string): ImportRow[] {
  const dir = join(userDataDir, 'tasks');
  const files = readJsonFiles<TaskJSON>(dir);
  if (files.length === 0) {
    console.log(`No tasks found in ${dir}`);
    return [];
  }
  console.log(`Reading ${files.length} task file(s) from ${dir}`);
  const rows: ImportRow[] = [];
  for (const { path, data } of files) {
    const title = (data.title ?? '').trim();
    if (!title) {
      console.warn(`  ! skipping ${path}: no title`);
      continue;
    }
    const status = (data.status ?? '').toLowerCase();
    if (status === 'backlog' || status === '') continue;

    if (status === 'done' || status === 'verified') {
      const day = toDay(data.updatedAt) ?? toDay(data.createdAt);
      if (!day) continue;
      rows.push({
        kind: 'done',
        content: title,
        day,
        hour: 17,
        status: 'open',
        source: `task ${data.id} (${status})`,
      });
    } else if (
      status === 'in-progress' ||
      status === 'review' ||
      status === 'auto-review'
    ) {
      const day = toDay(data.createdAt) ?? toDay(data.updatedAt);
      if (!day) continue;
      rows.push({
        kind: 'plan',
        content: title,
        day,
        hour: 9,
        status: 'open',
        source: `task ${data.id} (${status})`,
      });
    }
    // Unknown statuses are skipped silently.
  }
  return rows;
}

// --- main ---

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('daybook ← tix-kanban import');
  console.log(`  source:        ${args.source}`);
  console.log(`  user data:     ${args.userData}`);
  console.log(`  include tasks: ${args.includeTasks}`);
  console.log(`  dry run:       ${args.dryRun}`);
  console.log('');

  const rows: ImportRow[] = [];
  rows.push(...collectStandups(args.source));
  if (args.includeTasks) rows.push(...collectTasks(args.userData));

  if (rows.length === 0) {
    console.log('\nNothing to import.');
    return;
  }

  const dbPath = resolve(process.cwd(), 'data/daybook.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  // Sanity check: the schema must have 'plan' in its CHECK constraint.
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'")
    .get() as { sql: string } | undefined;
  if (!schema) {
    console.error(`\nNo 'entries' table at ${dbPath}. Run \`npm run dev\` once to initialize.`);
    process.exit(1);
  }
  if (!schema.sql.includes("'plan'")) {
    console.error(`\nDB schema is out of date (missing 'plan' kind). Start daybook once to migrate.`);
    process.exit(1);
  }

  const existsStmt = db.prepare(
    `SELECT 1 FROM entries WHERE kind = ? AND content = ? AND date(created_at) = ? LIMIT 1`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO entries (kind, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );

  let created = 0;
  let skipped = 0;

  const apply = db.transaction((batch: ImportRow[]) => {
    for (const r of batch) {
      const dup = existsStmt.get(r.kind, r.content, r.day);
      if (dup) {
        skipped++;
        continue;
      }
      if (args.dryRun) {
        console.log(`  + [${r.kind}] ${r.day} ${r.content}  (from ${r.source})`);
        created++;
        continue;
      }
      const ts = tsAt(r.day, r.hour);
      insertStmt.run(r.kind, r.content, r.status, ts, ts);
      created++;
    }
  });

  apply(rows);

  console.log('');
  if (args.dryRun) {
    console.log(`Would import ${created} new entries, ${skipped} already present.`);
    console.log('(no changes made — drop --dry-run to apply)');
  } else {
    console.log(`Imported ${created} new entries (${skipped} already present).`);
  }
  db.close();
}

main();
