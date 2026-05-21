import { useCallback, useEffect, useState } from 'react';
import { api, type Entry, type Kind } from './api';
import { EntryRow } from './EntryList';

const TITLES: Record<Kind, string> = {
  plan: 'Plan',
  done: 'Done',
  note: 'Notes',
  blocker: 'Blockers',
};

const PLACEHOLDERS: Record<Kind, string> = {
  plan: 'What do you plan to do today? (cmd/ctrl+enter to add)',
  done: 'What did you just finish? (cmd/ctrl+enter to add)',
  note: 'Jot a note for today... (cmd/ctrl+enter to add)',
  blocker: 'What is blocking you? (cmd/ctrl+enter to add)',
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function formatDateLabel(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function KindDayView({ kind, onChange }: { kind: Kind; onChange: () => void }) {
  const [date, setDate] = useState<string>(todayISO());
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');

  const load = useCallback(
    async (day: string) => {
      setLoading(true);
      try {
        const r = await api.list({
          kind,
          from: day,
          to: shiftDay(day, 1),
          pageSize: 200,
        });
        setRows(r.rows.slice().reverse());
      } finally {
        setLoading(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    load(date);
  }, [date, load]);

  // Reset the composer when switching kinds.
  useEffect(() => {
    setDraft('');
  }, [kind]);

  const isToday = date === todayISO();

  const submit = async () => {
    const c = draft.trim();
    if (!c) return;
    await api.create(kind, c);
    setDraft('');
    // New entries always land on today; jump there so the user sees the row.
    if (!isToday) {
      setDate(todayISO());
    } else {
      load(date);
    }
    onChange();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="kindday">
      <div className="standup-header-row">
        <h2>{TITLES[kind]}</h2>
      </div>

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
      {!isToday && draft.trim() && (
        <div className="composer-hint">
          Heads up — adding will create an entry on <strong>today</strong>, not on the date you're viewing.
        </div>
      )}

      <div className="standup-datebar">
        <button className="ghost" onClick={() => setDate(shiftDay(date, -1))} title="Previous day">
          ← Prev
        </button>
        <div className="standup-date">
          <strong>{formatDateLabel(date)}</strong>
          <input
            type="date"
            className="standup-date-picker"
            value={date}
            max={todayISO()}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
            title="Jump to a date"
          />
          {!isToday && (
            <button className="ghost small" onClick={() => setDate(todayISO())}>
              Today
            </button>
          )}
        </div>
        <button
          className="ghost"
          onClick={() => setDate(shiftDay(date, 1))}
          disabled={isToday}
          title={isToday ? 'No future dates' : 'Next day'}
        >
          Next →
        </button>
      </div>

      <div className="kindday-count">
        {loading
          ? 'Loading...'
          : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} on this day`}
      </div>

      {!loading && rows.length === 0 ? (
        <div className="empty">
          {isToday
            ? `No ${kind} entries today yet.`
            : `No ${kind} entries on this day.`}
        </div>
      ) : (
        <div className="entries">
          {rows.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              onChanged={() => {
                load(date);
                onChange();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
