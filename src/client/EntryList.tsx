import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Entry, type Kind, type Status } from './api';

const TITLES: Record<Kind, string> = {
  plan: 'Plan',
  done: 'Done',
  note: 'Notes',
  blocker: 'Blockers',
};

const PLACEHOLDERS: Record<Kind, string> = {
  plan: 'What do you plan to do today? (cmd/ctrl+enter to add)',
  done: 'What did you just finish? (cmd/ctrl+enter to add)',
  note: 'Jot a note for today...',
  blocker: 'What is blocking you?',
};

export function EntryList({ kind, onChange }: { kind: Kind; onChange: () => void }) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Status>(kind === 'blocker' ? 'open' : 'all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    rows: Entry[];
    total: number;
    page: number;
    pageCount: number;
  }>({ rows: [], total: 0, page: 1, pageCount: 1 });
  const [loading, setLoading] = useState(false);

  // Reset state when switching kinds
  useEffect(() => {
    setDraft('');
    setQ('');
    setStatusFilter(kind === 'blocker' ? 'open' : 'all');
    setPage(1);
  }, [kind]);

  const load = useCallback(() => {
    setLoading(true);
    api
      .list({
        kind,
        q: q || undefined,
        status: statusFilter === 'all' ? undefined : statusFilter,
        page,
        pageSize: 25,
      })
      .then((r) => setData(r))
      .finally(() => setLoading(false));
  }, [kind, q, statusFilter, page]);

  // Debounce search; immediate reload for other filters/page.
  useEffect(() => {
    const t = setTimeout(load, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const submit = async () => {
    const c = draft.trim();
    if (!c) return;
    await api.create(kind, c);
    setDraft('');
    setPage(1);
    load();
    onChange();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div>
      <h2>{TITLES[kind]}</h2>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDERS[kind]}
        />
        <button onClick={submit} disabled={!draft.trim()}>
          Add
        </button>
      </div>

      <div className="toolbar">
        <input
          type="text"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
          placeholder="Search..."
        />
        {kind === 'blocker' ? (
          <select
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value as 'all' | Status);
            }}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        ) : null}
        <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
          {loading ? 'Loading...' : `${data.total} ${data.total === 1 ? 'entry' : 'entries'}`}
        </span>
      </div>

      {data.rows.length === 0 ? (
        <div className="empty">
          {q ? 'No matches.' : `No ${kind} entries yet.`}
        </div>
      ) : (
        <div className="entries">
          {data.rows.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              onChanged={() => {
                load();
                onChange();
              }}
            />
          ))}
        </div>
      )}

      <Pagination
        page={data.page}
        pageCount={data.pageCount}
        onChange={(p) => setPage(p)}
      />
    </div>
  );
}

export function EntryRow({
  entry,
  onChanged,
  dateless = false,
}: {
  entry: Entry;
  onChanged: () => void;
  /** Omit the date from the meta line when the surrounding view is already scoped to one day. */
  dateless?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.content);

  const save = async () => {
    if (draft.trim() && draft !== entry.content) {
      await api.update(entry.id, { content: draft.trim() });
    }
    setEditing(false);
    onChanged();
  };

  const toggleStatus = async () => {
    await api.update(entry.id, {
      status: entry.status === 'open' ? 'resolved' : 'open',
    });
    onChanged();
  };

  const remove = async () => {
    if (!confirm('Delete this entry?')) return;
    await api.remove(entry.id);
    onChanged();
  };

  return (
    <div
      className={`entry ${entry.kind} ${entry.status === 'resolved' ? 'resolved' : ''} ${editing ? 'editing' : ''}`}
    >
      <span className="badge" />
      <div className="body">
        {editing ? (
          <textarea
            className="edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft(entry.content);
                setEditing(false);
              } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
            autoFocus
          />
        ) : (
          <div className="content">{entry.content}</div>
        )}
        <div className="meta">
          <span>{dateless ? formatTime(entry.created_at) : formatDate(entry.created_at)}</span>
          {entry.kind === 'blocker' ? <span>· {entry.status}</span> : null}
          {entry.updated_at !== entry.created_at ? (
            <span>· edited {formatDate(entry.updated_at)}</span>
          ) : null}
        </div>
      </div>
      <div className="actions">
        {editing ? (
          <>
            <button onClick={save}>Save</button>
            <button
              className="ghost"
              onClick={() => {
                setDraft(entry.content);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {entry.kind === 'blocker' ? (
              <button className="ghost" onClick={toggleStatus}>
                {entry.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
            ) : null}
            <button className="ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="danger icon-nav" onClick={remove} title="Delete entry" aria-label="Delete entry">
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pagination">
      <button className="ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ← Prev
      </button>
      <span>
        Page {page} of {pageCount}
      </span>
      <button
        className="ghost"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}

function formatDate(iso: string): string {
  // SQLite "datetime('now')" returns "YYYY-MM-DD HH:MM:SS" in UTC.
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
