# Daybook

A slim daily logbook focused on the pieces you actually use: track what you've done, jot notes, list current blockers, auto-generate standups, and export date-ranged JSON for AI agents to theme.

## Stack

- Vite + React + TypeScript (client, port 5173)
- Express + better-sqlite3 (server, port 3001)
- SQLite FTS5 for full-text search
- Single user, local-first

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

The SQLite database lives at `data/daybook.db`.

## Features

- **Done / Notes / Blockers** — three filtered views over one entries table.
- **Search** — full-text search over `content` (FTS5, prefix-match per token).
- **Pagination** — 25 per page.
- **Blocker status** — open/resolved toggle, defaults to showing open only.
- **Standup** — `/api/standup` returns yesterday's done, today's done so far, open blockers, today's notes — formatted as a copy-paste-ready text block.
- **Export** — `/api/export?range=week|month` or `from=YYYY-MM-DD&to=YYYY-MM-DD` returns JSON; add `?download=1` to force file download.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/entries?kind=&q=&status=&from=&to=&page=&pageSize=` | List/search (paginated) |
| POST | `/api/entries` | `{kind, content}` |
| PATCH | `/api/entries/:id` | `{content?, status?}` |
| DELETE | `/api/entries/:id` | |
| GET | `/api/standup` | Standup bundle |
| GET | `/api/export?range=week\|month` or `?from=&to=` | JSON dump; `?download=1` to attach |

## Feed export to an agent

```bash
curl -s "http://localhost:3001/api/export?range=month" \
  | claude -p "Extract recurring themes from these daybook entries"
```

## Importing from tix-kanban

If you used [tix-kanban](https://github.com/andywilliams/tix-kanban) before, there's a one-shot importer:

```bash
npm run import:tix-kanban -- \
  --source=/path/to/tix-kanban \
  --user-data=$HOME/.tix-kanban \
  --include-tasks \
  --dry-run
```

Drop `--dry-run` to actually write. The script is idempotent — re-running skips entries already imported (matched on `kind + content + day`).

Mappings:

| tix-kanban                                    | daybook                                         |
| --------------------------------------------- | ----------------------------------------------- |
| standup `yesterday[]`                         | `done` entry on the day before the standup      |
| standup `today[]`                             | `plan` entry on the standup day                 |
| standup `blockers[]`                          | `blocker` entry on the standup day (`resolved`) |
| task `done` / `verified`                      | `done` entry on the task's `updatedAt`          |
| task `in-progress` / `review` / `auto-review` | `plan` entry (open) on the task's `createdAt`   |
| task `backlog`                                | skipped                                         |

Historical blockers come in as `resolved` so they don't clutter the open-blockers view but remain searchable.
