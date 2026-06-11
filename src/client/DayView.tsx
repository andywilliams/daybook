import { useCallback, useEffect, useState } from 'react';
import { api, type Entry, type Kind } from './api';
import { EntryRow } from './EntryList';
import { DateBar } from './DateBar';
import { shiftDay, todayISO } from './dates';

const KIND_LABEL: Record<Kind, string> = {
  plan: 'Plan',
  done: 'Done',
  note: 'Note',
  blocker: 'Blocker',
};

export function DayView({ onChange }: { onChange: () => void }) {
  const [date, setDate] = useState<string>(todayISO());
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | Kind>('all');

  const load = useCallback(async (day: string) => {
    setLoading(true);
    try {
      const r = await api.list({
        from: day,
        to: shiftDay(day, 1),
        pageSize: 200,
      });
      // API returns DESC; flip to chronological.
      setRows(r.rows.slice().reverse());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(date);
  }, [date, load]);

  const counts: Record<Kind, number> = { plan: 0, done: 0, note: 0, blocker: 0 };
  for (const r of rows) counts[r.kind]++;

  const visible = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);

  return (
    <div className="day">
      <div className="standup-header-row">
        <h2>Day</h2>
      </div>

      <DateBar date={date} onChange={setDate} />

      <div className="day-filterbar">
        <FilterChip label="All" count={rows.length} active={filter === 'all'} onClick={() => setFilter('all')} />
        {(['plan', 'done', 'note', 'blocker'] as Kind[]).map((k) => (
          <FilterChip
            key={k}
            label={KIND_LABEL[k]}
            count={counts[k]}
            active={filter === k}
            onClick={() => setFilter(k)}
            kind={k}
          />
        ))}
      </div>

      {loading ? (
        <div className="empty">Loading...</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          {rows.length === 0
            ? 'No entries on this day.'
            : `No ${filter === 'all' ? '' : KIND_LABEL[filter as Kind].toLowerCase() + ' '}entries on this day.`}
        </div>
      ) : (
        <div className="entries">
          {visible.map((e) => (
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

function FilterChip({
  label,
  count,
  active,
  onClick,
  kind,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  kind?: Kind;
}) {
  return (
    <button
      className={`chip ${active ? 'active' : ''} ${kind ? `chip-${kind}` : ''}`}
      onClick={onClick}
      disabled={count === 0 && !active}
    >
      <span>{label}</span>
      <span className="chip-count">{count}</span>
    </button>
  );
}
