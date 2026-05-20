/**
 * Imports tix-kanban data into daybook.
 *
 *   tsx scripts/import-tix-kanban.ts [--source=<dir>] [--user-data=<dir>]
 *                                    [--notes-dir=<dir>]
 *                                    [--include-tasks] [--dry-run]
 *
 *   --source       Path to the tix-kanban project (contains data/standups/).
 *                  Default: ../tix-kanban
 *   --user-data    Path to the tix-kanban user dir (contains tasks/, daily-activity/).
 *                  Default: $HOME/.tix-kanban
 *   --notes-dir    Path to the daily notes dir written by the `tix` server.
 *                  Default: $HOME/.tix/notes
 *   --logs-dir     Path to the tix activity-log dir (same data as `tix log`).
 *                  Default: $HOME/.tix/logs
 *   --include-tasks  Also import kanban tasks (off by default).
 *   --dry-run      Show what would be imported; don't write anything.
 *
 * Mappings:
 *   standup yesterday[]  -> done entry on (standup.date - 1 day)
 *   standup today[]      -> plan entry on standup.date
 *   standup blockers[]   -> blocker entry on standup.date (status=resolved)
 *   daily note           -> note entry on note.date, ordered by note.timestamp
 *   tix log entry        -> done entry on log.date, ordered by log.timestamp
 *   daily-activity event -> note entry on event.date, ordered by event.timestamp
 *                           (task started/completed/failed, PR created/merged,
 *                           review completed)
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

interface NoteJSON {
  id?: string;
  timestamp?: string;
  date?: string;
  content?: string;
  author?: string;
}

interface LogJSON {
  timestamp?: string;
  date?: string;
  entry?: string;
  author?: string;
}

interface ActivityEvent {
  taskId?: string;
  title?: string;
  timestamp?: string;
  repo?: string;
  reason?: string;
  prNumber?: number;
  prUrl?: string;
}

interface PersonaActivity {
  tasks?: { started?: ActivityEvent[]; completed?: ActivityEvent[]; failed?: ActivityEvent[] };
  prs?: { created?: ActivityEvent[]; merged?: ActivityEvent[] };
  reviews?: { completed?: ActivityEvent[] };
}

interface DailyActivityJSON {
  date?: string;
  personas?: Record<string, PersonaActivity>;
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
  notesDir: string;
  logsDir: string;
  includeTasks: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: resolve(process.cwd(), '../tix-kanban'),
    userData: join(homedir(), '.tix-kanban'),
    notesDir: join(homedir(), '.tix', 'notes'),
    logsDir: join(homedir(), '.tix', 'logs'),
    includeTasks: false,
    dryRun: false,
  };
  for (const a of argv) {
    if (a.startsWith('--source=')) args.source = resolve(a.slice('--source='.length));
    else if (a.startsWith('--user-data=')) args.userData = resolve(a.slice('--user-data='.length));
    else if (a.startsWith('--notes-dir=')) args.notesDir = resolve(a.slice('--notes-dir='.length));
    else if (a.startsWith('--logs-dir=')) args.logsDir = resolve(a.slice('--logs-dir='.length));
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
    '  --user-data=<dir>    tix-kanban user dir (has tasks/, daily-activity/)',
    '  --notes-dir=<dir>    tix daily notes dir (default $HOME/.tix/notes)',
    '  --logs-dir=<dir>     tix activity log dir (default $HOME/.tix/logs)',
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

function hourOf(input: string | undefined | null, fallback: number): number {
  if (!input) return fallback;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.getUTCHours();
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

function collectNotes(notesDir: string): ImportRow[] {
  const files = readJsonFiles<NoteJSON[]>(notesDir);
  if (files.length === 0) {
    console.log(`No notes found in ${notesDir}`);
    return [];
  }
  console.log(`Reading ${files.length} note file(s) from ${notesDir}`);
  const rows: ImportRow[] = [];
  for (const { path, data } of files) {
    if (!Array.isArray(data)) {
      console.warn(`  ! skipping ${path}: not an array`);
      continue;
    }
    for (const note of data) {
      const content = (note.content ?? '').trim();
      if (!content || isPlaceholder(content)) continue;
      const day = toDay(note.timestamp) ?? toDay(note.date);
      if (!day) continue;
      rows.push({
        kind: 'note',
        content,
        day,
        hour: hourOf(note.timestamp, 12),
        status: 'open',
        source: `note ${note.id ?? day}`,
      });
    }
  }
  return rows;
}

function collectLogs(logsDir: string): ImportRow[] {
  const files = readJsonFiles<LogJSON[]>(logsDir);
  if (files.length === 0) {
    console.log(`No activity logs found in ${logsDir}`);
    return [];
  }
  console.log(`Reading ${files.length} activity-log file(s) from ${logsDir}`);
  const rows: ImportRow[] = [];
  for (const { path, data } of files) {
    if (!Array.isArray(data)) {
      console.warn(`  ! skipping ${path}: not an array`);
      continue;
    }
    for (const log of data) {
      const content = (log.entry ?? '').trim();
      if (!content || isPlaceholder(content)) continue;
      const day = toDay(log.timestamp) ?? toDay(log.date);
      if (!day) continue;
      rows.push({
        kind: 'done',
        content,
        day,
        hour: hourOf(log.timestamp, 17),
        status: 'open',
        source: `tix log ${day}`,
      });
    }
  }
  return rows;
}

function describeActivity(
  bucket: 'started' | 'completed' | 'failed' | 'created' | 'merged' | 'review',
  event: ActivityEvent,
): string | null {
  const repo = event.repo ? ` in ${event.repo}` : '';
  const title = (event.title ?? '').trim();
  switch (bucket) {
    case 'started':
      return title ? `Started task: ${title}${repo}` : null;
    case 'completed':
      return title ? `Completed task: ${title}${repo}` : null;
    case 'failed': {
      if (!title) return null;
      const reason = event.reason ? ` (${event.reason})` : '';
      return `Failed task: ${title}${repo}${reason}`;
    }
    case 'created':
      return event.prNumber ? `Created PR #${event.prNumber}${repo}` : null;
    case 'merged':
      return event.prNumber ? `Merged PR #${event.prNumber}${repo}` : null;
    case 'review':
      return event.prNumber
        ? `Completed review of PR #${event.prNumber}${repo}`
        : title
          ? `Completed review: ${title}${repo}`
          : null;
  }
}

function collectActivity(userDataDir: string): ImportRow[] {
  const dir = join(userDataDir, 'daily-activity');
  const files = readJsonFiles<DailyActivityJSON>(dir);
  if (files.length === 0) {
    console.log(`No daily-activity files found in ${dir}`);
    return [];
  }
  console.log(`Reading ${files.length} daily-activity file(s) from ${dir}`);
  const rows: ImportRow[] = [];
  for (const { data } of files) {
    const fileDay = toDay(data.date);
    for (const persona of Object.values(data.personas ?? {})) {
      const buckets: Array<[Parameters<typeof describeActivity>[0], ActivityEvent[] | undefined]> = [
        ['started', persona.tasks?.started],
        ['completed', persona.tasks?.completed],
        ['failed', persona.tasks?.failed],
        ['created', persona.prs?.created],
        ['merged', persona.prs?.merged],
        ['review', persona.reviews?.completed],
      ];
      for (const [bucket, events] of buckets) {
        for (const event of events ?? []) {
          const content = describeActivity(bucket, event);
          if (!content) continue;
          const day = toDay(event.timestamp) ?? fileDay;
          if (!day) continue;
          rows.push({
            kind: 'note',
            content,
            day,
            hour: hourOf(event.timestamp, 12),
            status: 'open',
            source: `activity ${day} ${bucket}`,
          });
        }
      }
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
  console.log(`  notes dir:     ${args.notesDir}`);
  console.log(`  logs dir:      ${args.logsDir}`);
  console.log(`  include tasks: ${args.includeTasks}`);
  console.log(`  dry run:       ${args.dryRun}`);
  console.log('');

  const rows: ImportRow[] = [];
  rows.push(...collectStandups(args.source));
  rows.push(...collectNotes(args.notesDir));
  rows.push(...collectLogs(args.logsDir));
  rows.push(...collectActivity(args.userData));
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
