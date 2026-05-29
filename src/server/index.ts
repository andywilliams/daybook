import express, { type Request, type Response } from 'express';
import { db, type Entry, type Kind, type StandupSnapshotRow, type ReviewRow } from './db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT ?? 3001);

const KINDS: Kind[] = ['done', 'plan', 'note', 'blocker'];
const isKind = (v: unknown): v is Kind => typeof v === 'string' && (KINDS as string[]).includes(v);

// --- CRUD ---

app.post('/api/entries', (req: Request, res: Response) => {
  const { kind, content } = req.body ?? {};
  if (!isKind(kind)) return res.status(400).json({ error: 'invalid kind' });
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content required' });
  }
  const stmt = db.prepare(
    `INSERT INTO entries (kind, content) VALUES (?, ?) RETURNING *`,
  );
  const row = stmt.get(kind, content.trim()) as Entry;
  res.status(201).json(row);
});

app.patch('/api/entries/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { content, status } = req.body ?? {};
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof content === 'string') {
    sets.push('content = ?');
    args.push(content.trim());
  }
  if (status === 'open' || status === 'resolved') {
    sets.push('status = ?');
    args.push(status);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push("updated_at = datetime('now')");
  args.push(id);
  const row = db
    .prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .get(...args) as Entry | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.delete('/api/entries/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const info = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// --- List / search (paginated) ---

app.get('/api/entries', (req: Request, res: Response) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const offset = (page - 1) * pageSize;

  if (kind && !isKind(kind)) return res.status(400).json({ error: 'bad kind' });

  const where: string[] = [];
  const args: unknown[] = [];

  if (q) {
    where.push('e.id IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)');
    args.push(toFtsQuery(q));
  }
  if (kind) {
    where.push('e.kind = ?');
    args.push(kind);
  }
  if (status === 'open' || status === 'resolved') {
    where.push('e.status = ?');
    args.push(status);
  }
  if (from) {
    where.push('e.created_at >= ?');
    args.push(from);
  }
  if (to) {
    where.push('e.created_at < ?');
    args.push(to);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db
    .prepare(`SELECT COUNT(*) AS n FROM entries e ${whereSql}`)
    .get(...args) as { n: number }).n;

  const rows = db
    .prepare(
      `SELECT e.* FROM entries e ${whereSql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, offset) as Entry[];

  res.json({ rows, total, page, pageSize, pageCount: Math.ceil(total / pageSize) });
});

// --- Standup ---

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDayISO(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function entriesOn(day: string, kind: Kind): Entry[] {
  return db
    .prepare(
      `SELECT * FROM entries
       WHERE kind = ? AND date(created_at) = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(kind, day) as Entry[];
}

// The "yesterday" section pulls from your previous *working* day, which we
// infer as the most recent earlier day that actually has `done` entries.
// This skips weekends and bank holidays automatically — you logged nothing
// on those days. Falls back to the previous calendar day if nothing's logged.
function previousDoneDate(beforeDate: string): string {
  const row = db
    .prepare(
      `SELECT date(created_at) AS d FROM entries
       WHERE kind = 'done' AND date(created_at) < ?
       ORDER BY d DESC LIMIT 1`,
    )
    .get(beforeDate) as { d: string } | undefined;
  return row?.d ?? shiftDayISO(beforeDate, -1);
}

interface StandupSections {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

// `prev` overrides which day the "yesterday" section pulls from; when omitted
// it defaults to the previous working day (see previousDoneDate). The resolved
// source day is returned as `prevDate` so the client can display/seed its picker.
function livePreview(date: string, prev?: string): StandupSections & { prevDate: string } {
  const prevDate = prev ?? previousDoneDate(date);
  const yesterday = entriesOn(prevDate, 'done').map((e) => e.content);
  const today = entriesOn(date, 'plan').map((e) => e.content);
  // For "today" (real today), use currently-open blockers; for past dates,
  // use blockers that existed on that date.
  let blockerEntries: Entry[];
  if (date === todayISO()) {
    blockerEntries = db
      .prepare(
        `SELECT * FROM entries WHERE kind = 'blocker' AND status = 'open'
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as Entry[];
  } else {
    blockerEntries = entriesOn(date, 'blocker');
  }
  return { yesterday, today, blockers: blockerEntries.map((e) => e.content), prevDate };
}

function getSnapshot(date: string): StandupSnapshotRow | undefined {
  return db.prepare('SELECT * FROM standups WHERE date = ?').get(date) as
    | StandupSnapshotRow
    | undefined;
}

function parseSnapshot(row: StandupSnapshotRow): StandupSections {
  return {
    yesterday: JSON.parse(row.yesterday),
    today: JSON.parse(row.today),
    blockers: JSON.parse(row.blockers),
  };
}

function sanitizeSections(input: unknown): StandupSections | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const out: StandupSections = { yesterday: [], today: [], blockers: [] };
  for (const key of ['yesterday', 'today', 'blockers'] as const) {
    const arr = obj[key];
    if (!Array.isArray(arr)) return null;
    out[key] = arr.map((v) => (typeof v === 'string' ? v : '')).filter((v) => v.trim().length > 0);
  }
  return out;
}

app.get('/api/standup', (req: Request, res: Response) => {
  const date = typeof req.query.date === 'string' && DATE_RE.test(req.query.date)
    ? req.query.date
    : todayISO();
  const snapshot = getSnapshot(date);
  if (snapshot) {
    res.json({
      date,
      sections: parseSnapshot(snapshot),
      locked: true,
      submittedAt: snapshot.submitted_at,
      updatedAt: snapshot.updated_at,
    });
    return;
  }
  const prev =
    typeof req.query.prev === 'string' && DATE_RE.test(req.query.prev) && req.query.prev < date
      ? req.query.prev
      : undefined;
  const { prevDate, ...sections } = livePreview(date, prev);
  res.json({ date, sections, locked: false, prevDate });
});

app.post('/api/standup', (req: Request, res: Response) => {
  const { date, sections } = req.body ?? {};
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'invalid date' });
  }
  const clean = sanitizeSections(sections);
  if (!clean) return res.status(400).json({ error: 'invalid sections' });
  const existing = getSnapshot(date);
  if (existing) {
    db.prepare(
      `UPDATE standups SET yesterday = ?, today = ?, blockers = ?, updated_at = datetime('now')
       WHERE date = ?`,
    ).run(JSON.stringify(clean.yesterday), JSON.stringify(clean.today), JSON.stringify(clean.blockers), date);
  } else {
    db.prepare(
      `INSERT INTO standups (date, yesterday, today, blockers)
       VALUES (?, ?, ?, ?)`,
    ).run(date, JSON.stringify(clean.yesterday), JSON.stringify(clean.today), JSON.stringify(clean.blockers));
  }
  const row = getSnapshot(date)!;
  res.status(existing ? 200 : 201).json({
    date,
    sections: parseSnapshot(row),
    locked: true,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  });
});

app.delete('/api/standup/:date', (req: Request, res: Response) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'invalid date' });
  db.prepare('DELETE FROM standups WHERE date = ?').run(date);
  res.status(204).end();
});

app.get('/api/standup/history', (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 30), 1), 365);
  const rows = db
    .prepare('SELECT date, submitted_at, updated_at FROM standups ORDER BY date DESC LIMIT ?')
    .all(limit) as Array<Pick<StandupSnapshotRow, 'date' | 'submitted_at' | 'updated_at'>>;
  res.json({ rows });
});

// --- Reviews ---

const PERIODS = new Set(['week', 'month', 'quarter']);
const QUARTER_START_MONTHS = new Set([0, 3, 6, 9]); // Jan, Apr, Jul, Oct (0-indexed)

function parseUtcDate(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

function lastDayOfMonth(year: number, month: number): number {
  // month is 0-indexed; day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function validatePeriodRange(period: string, from: string, to: string): string | null {
  const f = parseUtcDate(from);
  const t = parseUtcDate(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return 'invalid date';
  if (period === 'week') {
    // Mon → Fri (5 weekdays, 4 days apart). 1 = Monday in getUTCDay().
    if (f.getUTCDay() !== 1) return 'week must start on a Monday';
    if (t.getUTCDay() !== 5) return 'week must end on a Friday';
    const diffMs = t.getTime() - f.getTime();
    const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    if (diffDays !== 4) return 'week must be Monday–Friday of the same week';
  } else if (period === 'month') {
    if (f.getUTCDate() !== 1) return 'month must start on the 1st';
    if (f.getUTCFullYear() !== t.getUTCFullYear() || f.getUTCMonth() !== t.getUTCMonth()) {
      return 'month from/to must be in the same calendar month';
    }
    const expectedLast = lastDayOfMonth(f.getUTCFullYear(), f.getUTCMonth());
    if (t.getUTCDate() !== expectedLast) {
      return `month must end on the last day (expected ${expectedLast})`;
    }
  } else if (period === 'quarter') {
    if (f.getUTCDate() !== 1) return 'quarter must start on the 1st';
    if (!QUARTER_START_MONTHS.has(f.getUTCMonth())) {
      return 'quarter must start in January, April, July or October';
    }
    const expectedToMonth = f.getUTCMonth() + 2; // Mar/Jun/Sep/Dec
    if (t.getUTCFullYear() !== f.getUTCFullYear() || t.getUTCMonth() !== expectedToMonth) {
      return 'quarter from/to must span exactly three calendar months';
    }
    const expectedLast = lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth());
    if (t.getUTCDate() !== expectedLast) {
      return `quarter must end on the last day of month ${expectedToMonth + 1} (expected day ${expectedLast})`;
    }
  }
  return null;
}

function validateContent(content: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!content || typeof content !== 'object') return { ok: false, reason: 'content must be an object' };
  const c = content as Record<string, unknown>;
  if (typeof c.headline !== 'string' || !c.headline.trim()) return { ok: false, reason: 'headline required' };
  if (typeof c.summary !== 'string') return { ok: false, reason: 'summary required (string)' };
  if (!Array.isArray(c.stats)) return { ok: false, reason: 'stats must be an array' };
  if (!Array.isArray(c.sections)) return { ok: false, reason: 'sections must be an array' };
  if (c.charts !== undefined && !Array.isArray(c.charts)) {
    return { ok: false, reason: 'charts must be an array if present' };
  }
  return { ok: true, value: content };
}

function reviewRowToApi(row: ReviewRow) {
  return {
    id: row.id,
    period: row.period,
    from_date: row.from_date,
    to_date: row.to_date,
    content: JSON.parse(row.content),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

app.post('/api/reviews', (req: Request, res: Response) => {
  const { period, from, to, content } = req.body ?? {};
  if (typeof period !== 'string' || !PERIODS.has(period)) {
    return res.status(400).json({ error: 'period must be week/month/quarter' });
  }
  if (typeof from !== 'string' || !DATE_RE.test(from)) {
    return res.status(400).json({ error: 'invalid from date' });
  }
  if (typeof to !== 'string' || !DATE_RE.test(to)) {
    return res.status(400).json({ error: 'invalid to date' });
  }
  if (from > to) return res.status(400).json({ error: 'from must be <= to' });
  const boundsErr = validatePeriodRange(period, from, to);
  if (boundsErr) return res.status(400).json({ error: boundsErr });
  const check = validateContent(content);
  if (!check.ok) return res.status(400).json({ error: check.reason });

  const existing = db
    .prepare('SELECT id FROM reviews WHERE period = ? AND from_date = ? AND to_date = ?')
    .get(period, from, to) as { id: number } | undefined;

  let id: number;
  if (existing) {
    db.prepare(
      `UPDATE reviews SET content = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(check.value), existing.id);
    id = existing.id;
  } else {
    const result = db
      .prepare(
        `INSERT INTO reviews (period, from_date, to_date, content) VALUES (?, ?, ?, ?)`,
      )
      .run(period, from, to, JSON.stringify(check.value));
    id = Number(result.lastInsertRowid);
  }
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow;
  res.status(existing ? 200 : 201).json(reviewRowToApi(row));
});

app.get('/api/reviews', (req: Request, res: Response) => {
  const period = typeof req.query.period === 'string' ? req.query.period : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 365);
  const args: unknown[] = [];
  let where = '';
  if (period) {
    if (!PERIODS.has(period)) return res.status(400).json({ error: 'bad period' });
    where = 'WHERE period = ?';
    args.push(period);
  }
  const rows = db
    .prepare(
      `SELECT * FROM reviews ${where} ORDER BY from_date DESC, id DESC LIMIT ?`,
    )
    .all(...args, limit) as ReviewRow[];
  res.json({ rows: rows.map(reviewRowToApi) });
});

app.get('/api/reviews/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(reviewRowToApi(row));
});

app.delete('/api/reviews/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  res.status(204).end();
});

// --- Agent instructions ---

const AGENTS_MD = `# Daybook — Instructions for AI Agents

Daybook is a personal work journal. It stores entries (\`plan\` / \`done\` /
\`note\` / \`blocker\`), submitted standup snapshots, and periodic *reviews*
(weekly / monthly / quarterly infographics) generated by AI agents from
exported entry data.

This document is the canonical contract for agents. If you are an LLM
reading this, you can act on the Daybook API after reading just this page.
A short discovery summary is also served at \`/llms.txt\`.

## Base URL

When the dev server is running the API lives at \`http://localhost:3001\`.
The Vite dev server on \`5173\` proxies \`/api/*\` through to it. All paths
below are relative to either origin — use whichever is reachable.

## Endpoint map

| Method | Path | Purpose |
|---|---|---|
| GET | /api/entries | List entries with kind/date/status filters |
| POST | /api/entries | Create a new entry |
| PATCH | /api/entries/:id | Update content or status |
| DELETE | /api/entries/:id | Delete |
| GET | /api/standup?date=YYYY-MM-DD&prev=YYYY-MM-DD | Live preview or locked snapshot (\`prev\` overrides the "yesterday" source day) |
| POST | /api/standup | Upsert a standup snapshot for a date |
| DELETE | /api/standup/:date | Unlock a date (revert to live preview) |
| GET | /api/standup/history | Recent submitted standup dates |
| GET | /api/reviews | List reviews (filter \`?period=week|month|quarter\`) |
| GET | /api/reviews/:id | Fetch one review |
| POST | /api/reviews | Create or rebuild a review |
| DELETE | /api/reviews/:id | Delete a review |
| GET | /api/export | Export entries as JSON (range or from/to) |
| GET | /api/agents.md | This document |

## Periodic reviews

Reviews are the main artefact agents produce. The user exports their
entries; you analyse them; you POST a review for a *bounded* period.

### Period bounds — enforced server-side

| Period | \`from\` | \`to\` |
|---|---|---|
| week | A **Monday** | The **Friday** of the same week (4 days later) |
| month | The **1st** of the month | The **last day** of that month |
| quarter | Jan 1 / Apr 1 / Jul 1 / Oct 1 | Last day of the third month in the quarter |

POSTs that don't match return \`400\` with a human-readable reason
(e.g. \`week must start on a Monday\`). Do not try to widen or narrow a
period; pick the right canonical range or refuse.

### Upsert semantics

\`POST /api/reviews\` upserts by \`(period, from, to)\`. Re-running the
same period+dates updates the existing card in place and bumps
\`updated_at\`. Different period or different dates ⇒ a new card.

### Content schema

The \`content\` field is structured JSON. The UI renders each section kind
appropriately, so emit them rather than markdown.

\`\`\`json
{
  "headline": "<one-line summary, ~10 words>",
  "summary": "<short paragraph framing the period>",
  "stats": [
    { "label": "Entries", "value": 17, "sublabel": "optional" }
  ],
  "charts": [
    {
      "type": "bar",
      "title": "Entries by day",
      "data": [{ "label": "Mon 11", "value": 5 }]
    }
  ],
  "sections": [
    { "kind": "wins",    "title": "Wins",    "items": ["string"] },
    { "kind": "stuck",   "title": "Stuck",   "items": [{ "title": "...", "body": "..." }] },
    { "kind": "themes",  "title": "Themes",  "items": [{ "title": "...", "body": "..." }] },
    { "kind": "people",  "title": "People",  "items": [{ "name": "Piotr", "count": 3, "note": "optional" }] },
    { "kind": "tickets", "title": "Tickets", "items": [{ "id": "TN-17106", "count": 1, "note": "optional" }] },
    { "kind": "prose",   "title": "Notes",   "body": "free-form paragraph" }
  ]
}
\`\`\`

\`sections\` can contain any subset of these kinds in any order. Omit
\`title\` to use the default. \`charts\` is optional.

### Workflow

1. Resolve the user's request to a period and canonical bounds.
   *"Last week"* → most recent completed Mon–Fri.
   *"April"* → \`period=month\`, \`from=YYYY-04-01\`, \`to=YYYY-04-30\`.
   *"Q2 2026"* → \`period=quarter\`, \`from=2026-04-01\`, \`to=2026-06-30\`.
2. Fetch the entries strictly inside that range. \`to\` on \`/api/entries\`
   is exclusive, so pass the day **after** the canonical \`to\`:
   \`\`\`
   GET /api/entries?from=2026-05-11&to=2026-05-16&pageSize=500
   \`\`\`
3. Build the analysis from those entries only. Do not include entries
   outside the bounds even if they feel relevant.
4. POST:
   \`\`\`
   POST /api/reviews
   { "period": "week", "from": "2026-05-11", "to": "2026-05-15", "content": { ... } }
   \`\`\`
5. If the user re-exports later (e.g. Friday → Monday) and asks for a
   rebuild, POST the **same** period+dates. The card updates in place.

### Invocation phrases the user is likely to use

| User says | You do |
|---|---|
| "Generate the weekly review" | Most recent completed Mon–Fri |
| "Generate the review for the week of 18 May" | Mon–Fri containing 18 May |
| "Generate April's monthly review" | period=month, Apr 1 → Apr 30 |
| "Generate Q2 2026" | period=quarter, Apr 1 → Jun 30 |
| "Rebuild last week's review" | Re-POST same period+dates |

## Entries

\`GET /api/entries?kind=&q=&status=&from=&to=&page=&pageSize=\`
- \`kind\`: \`plan\` | \`done\` | \`note\` | \`blocker\`
- \`status\`: \`open\` | \`resolved\` (only meaningful for blockers)
- \`from\` is inclusive, \`to\` is **exclusive** (half-open range)
- \`q\` runs FTS5 against entry content

\`POST /api/entries\` body \`{ kind, content }\` — creates an entry on
"today" (server clock).

## Standup snapshots

\`GET /api/standup?date=YYYY-MM-DD\` returns either a locked snapshot or
a live preview built from that day's entries. The "yesterday" section
pulls from your previous working day (the most recent earlier day with
\`done\` entries — skips weekends/holidays); pass \`&prev=YYYY-MM-DD\` to
override which day it pulls from. \`prevDate\` echoes the resolved source:
\`\`\`json
{
  "date": "2026-05-20",
  "sections": { "yesterday": [], "today": [], "blockers": [] },
  "locked": false,
  "prevDate": "2026-05-19",
  "submittedAt": "optional, only if locked",
  "updatedAt": "optional, only if locked"
}
\`\`\`

\`POST /api/standup\` with \`{ date, sections }\` upserts the snapshot.
Standup edits do not modify underlying entries — they are independent.

## Export

\`GET /api/export?range=week|month\` or \`?from=&to=\` returns the full
entry set for the range as JSON. This is the format the user shares with
you when asking for a review.

## Conventions and gotchas

- All timestamps are SQLite UTC strings (\`YYYY-MM-DD HH:MM:SS\`).
  Treat the date portion as authoritative; hour resolution is often
  approximate for imported data.
- The DB was bootstrapped from a separate tool ("tix-kanban" / "Forge").
  Notes are the richest source of narrative; \`done\` entries are usually
  short titles. Lean on notes for themes.
- Blockers were not historically tracked, so an empty blocker history
  before May 2026 is expected — don't infer the user had none.
- The user works in the EqualsGroup repositories; common ticket prefixes
  are \`TN-\` and \`RP\`, and PRs are typically referenced as
  \`em-<repo> PR <n>\`.
- When generating reviews, prefer specifics from the user's entries
  (people named, tickets numbered, repos referenced) over generic prose.
  The user values being able to recognise their own week.
`;

const LLMS_TXT = `# Daybook

Daybook is a personal work journal with a small HTTP API. It stores
entries (plan/done/note/blocker), standup snapshots, and periodic
reviews ("infographics") that AI agents generate from exported entry
data.

If you are an AI agent and a human has asked you to interact with this
project, read the full agent contract at /agents.md before making
any requests. It covers period bounds (weeks = Mon-Fri, months = 1st
to last, quarters = aligned), the JSON content schema for reviews, the
upsert semantics for rebuilds, and the recommended workflow.

## Key documents

- /agents.md — Full API contract and workflow for agents.

## Quick endpoint list

- GET    /api/entries
- POST   /api/entries
- PATCH  /api/entries/:id
- DELETE /api/entries/:id
- GET    /api/standup?date=YYYY-MM-DD
- POST   /api/standup
- GET    /api/reviews
- POST   /api/reviews
- DELETE /api/reviews/:id
- GET    /api/export
`;

function serveMarkdown(body: string) {
  return (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(body);
  };
}

function serveText(body: string) {
  return (_req: Request, res: Response) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(body);
  };
}

// Discovery entry — llmstxt.org convention.
app.get('/llms.txt', serveText(LLMS_TXT));
// Full contract — root URL is the canonical location for agents.
app.get('/agents.md', serveMarkdown(AGENTS_MD));
// Back-compat alias under /api so the doc is also reachable through
// the existing proxy regex without any vite.config changes.
app.get('/api/agents.md', serveMarkdown(AGENTS_MD));

// --- Export ---

app.get('/api/export', (req: Request, res: Response) => {
  const range = typeof req.query.range === 'string' ? req.query.range : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;

  let fromExpr = '';
  let toExpr = '';

  if (range === 'week') fromExpr = `datetime('now','-7 days')`;
  else if (range === 'month') fromExpr = `datetime('now','-1 month')`;

  const where: string[] = [];
  const args: unknown[] = [];
  if (fromExpr) where.push(`created_at >= ${fromExpr}`);
  if (from) {
    where.push('created_at >= ?');
    args.push(from);
  }
  if (to) {
    where.push('created_at < ?');
    args.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db
    .prepare(`SELECT * FROM entries ${whereSql} ORDER BY created_at ASC`)
    .all(...args) as Entry[];

  const payload = {
    exportedAt: new Date().toISOString(),
    range: { range: range ?? null, from: from ?? null, to: to ?? null },
    count: rows.length,
    entries: rows,
  };

  const dispose = typeof req.query.download === 'string';
  if (dispose) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="daybook-${new Date().toISOString().slice(0, 10)}.json"`,
    );
  }
  res.json(payload);
});

app.listen(PORT, () => {
  console.log(`daybook server on http://localhost:${PORT}`);
});

// --- helpers ---

function toFtsQuery(q: string): string {
  // Escape FTS5 reserved chars by quoting each token; append * for prefix match.
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}

