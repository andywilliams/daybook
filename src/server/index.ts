import express, { type Request, type Response } from 'express';
import { db, type Entry, type Kind } from './db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT ?? 3001);

const KINDS: Kind[] = ['done', 'note', 'blocker'];
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

app.get('/api/standup', (_req: Request, res: Response) => {
  const startOfYesterday = "datetime('now','start of day','-1 day')";
  const startOfToday = "datetime('now','start of day')";
  const startOfTomorrow = "datetime('now','start of day','+1 day')";

  const yesterdayDone = db
    .prepare(
      `SELECT * FROM entries
       WHERE kind = 'done' AND created_at >= ${startOfYesterday} AND created_at < ${startOfToday}
       ORDER BY created_at ASC`,
    )
    .all() as Entry[];

  const todayDone = db
    .prepare(
      `SELECT * FROM entries
       WHERE kind = 'done' AND created_at >= ${startOfToday} AND created_at < ${startOfTomorrow}
       ORDER BY created_at ASC`,
    )
    .all() as Entry[];

  const openBlockers = db
    .prepare(
      `SELECT * FROM entries WHERE kind = 'blocker' AND status = 'open'
       ORDER BY created_at ASC`,
    )
    .all() as Entry[];

  const todayNotes = db
    .prepare(
      `SELECT * FROM entries
       WHERE kind = 'note' AND created_at >= ${startOfToday} AND created_at < ${startOfTomorrow}
       ORDER BY created_at ASC`,
    )
    .all() as Entry[];

  const text = formatStandup({ yesterdayDone, todayDone, openBlockers, todayNotes });
  res.json({ yesterdayDone, todayDone, openBlockers, todayNotes, text });
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

function formatStandup(opts: {
  yesterdayDone: Entry[];
  todayDone: Entry[];
  openBlockers: Entry[];
  todayNotes: Entry[];
}): string {
  const bullets = (xs: Entry[]) =>
    xs.length ? xs.map((e) => `- ${e.content}`).join('\n') : '- (nothing)';
  const sections = [
    `*Yesterday*\n${bullets(opts.yesterdayDone)}`,
    `*Today (so far)*\n${bullets(opts.todayDone)}`,
    `*Blockers*\n${bullets(opts.openBlockers)}`,
  ];
  if (opts.todayNotes.length) sections.push(`*Notes*\n${bullets(opts.todayNotes)}`);
  return sections.join('\n\n');
}
