import express, { type Request, type Response } from 'express';
import { db, type Entry, type Kind, type StandupSnapshotRow } from './db.js';

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

interface StandupSections {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

function livePreview(date: string): StandupSections {
  const yesterday = entriesOn(shiftDayISO(date, -1), 'done').map((e) => e.content);
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
  return { yesterday, today, blockers: blockerEntries.map((e) => e.content) };
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
  res.json({ date, sections: livePreview(date), locked: false });
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

