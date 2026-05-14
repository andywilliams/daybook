import { useEffect, useState } from 'react';
import { api, type Kind } from './api';
import { EntryList } from './EntryList';
import { StandupView } from './StandupView';
import { ExportView } from './ExportView';

type View = Kind | 'standup' | 'export';

const NAV: { id: View; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'done', label: 'Done' },
  { id: 'note', label: 'Notes' },
  { id: 'blocker', label: 'Blockers' },
  { id: 'standup', label: 'Standup' },
  { id: 'export', label: 'Export' },
];

const COUNT_KINDS: Kind[] = ['plan', 'done', 'note', 'blocker'];

export function App() {
  const [view, setView] = useState<View>('standup');
  const [counts, setCounts] = useState<Record<Kind, number>>({
    plan: 0,
    done: 0,
    note: 0,
    blocker: 0,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    Promise.all(
      COUNT_KINDS.map((k) =>
        api.list(k === 'blocker' ? { kind: k, status: 'open', pageSize: 1 } : { kind: k, pageSize: 1 }),
      ),
    ).then((results) => {
      const next = { ...counts };
      COUNT_KINDS.forEach((k, i) => {
        next[k] = results[i].total;
      });
      setCounts(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Daybook</h1>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${view === n.id ? 'active' : ''}`}
            onClick={() => setView(n.id)}
          >
            <span>{n.label}</span>
            {n.id === 'plan' || n.id === 'done' || n.id === 'note' || n.id === 'blocker' ? (
              <span className="count">
                {counts[n.id]}
                {n.id === 'blocker' ? ' open' : ''}
              </span>
            ) : null}
          </button>
        ))}
      </aside>
      <main className="main">
        {view === 'standup' ? (
          <StandupView onChange={bump} />
        ) : view === 'export' ? (
          <ExportView />
        ) : (
          <EntryList kind={view} onChange={bump} />
        )}
      </main>
    </div>
  );
}
