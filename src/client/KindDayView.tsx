import { useCallback, useEffect, useState } from 'react';
import { api, type Entry, type Kind } from './api';
import { EntryRow } from './EntryList';
import { DateBar } from './DateBar';
import { formatShortDate, shiftDay, todayISO } from './dates';

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

const CARRY_DISMISS_KEY = 'daybook-carryover-dismissed';

export function KindDayView({ kind, onChange }: { kind: Kind; onChange: () => void }) {
  const [date, setDate] = useState<string>(todayISO());
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [carry, setCarry] = useState<{ day: string; items: Entry[] } | null>(null);
  const [carryDismissed, setCarryDismissed] = useState(
    () => localStorage.getItem(CARRY_DISMISS_KEY) === todayISO(),
  );

  // Plans from the most recent earlier day that has any — the morning
  // triage list. Entries are returned newest-first, so the first row's
  // day is that source day.
  const loadCarry = useCallback(async () => {
    if (kind !== 'plan') {
      setCarry(null);
      return;
    }
    const r = await api.list({ kind: 'plan', to: todayISO(), pageSize: 25 });
    const day = r.rows[0]?.created_at.slice(0, 10);
    if (!day) {
      setCarry(null);
      return;
    }
    setCarry({ day, items: r.rows.filter((e) => e.created_at.slice(0, 10) === day) });
  }, [kind]);

  useEffect(() => {
    loadCarry();
  }, [loadCarry]);

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

  const bringForward = async (entries: Entry[]) => {
    for (const e of entries) {
      await api.create('plan', e.content);
    }
    if (!isToday) setDate(todayISO());
    else load(date);
    onChange();
  };

  const dismissCarry = () => {
    localStorage.setItem(CARRY_DISMISS_KEY, todayISO());
    setCarryDismissed(true);
  };

  const todayContents = new Set(rows.map((r) => r.content));
  const showCarry =
    kind === 'plan' && isToday && !carryDismissed && carry !== null && carry.items.length > 0;

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

      {showCarry && carry && (
        <div className="carryover">
          <div className="carryover-head">
            <span className="carryover-title">
              Plans from {formatShortDate(carry.day)} — still working on any of these?
            </span>
            <button
              className="carryover-dismiss"
              onClick={dismissCarry}
              title="Hide for today"
              aria-label="Hide for today"
            >
              ✕
            </button>
          </div>
          <ul className="carryover-list">
            {carry.items.map((e) => {
              const added = todayContents.has(e.content);
              return (
                <li key={e.id} className="carryover-item">
                  <span className="carryover-content">{e.content}</span>
                  {added ? (
                    <span className="carryover-added">✓ added</span>
                  ) : (
                    <button className="ghost small" onClick={() => bringForward([e])}>
                      ↪ Today
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {carry.items.filter((e) => !todayContents.has(e.content)).length > 1 && (
            <button
              className="ghost small"
              onClick={() => bringForward(carry.items.filter((e) => !todayContents.has(e.content)))}
            >
              Bring all forward
            </button>
          )}
        </div>
      )}

      <DateBar date={date} onChange={setDate} />

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
              dateless
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
