import { useEffect, useRef, useState } from 'react';
import { api, type Kind } from './api';
import { EntryList } from './EntryList';
import { KindDayView } from './KindDayView';
import { StandupView } from './StandupView';
import { DayView } from './DayView';
import { ReviewsView } from './ReviewsView';
import { ExportView } from './ExportView';
import { shiftDay, todayISO } from './dates';

type View = Kind | 'standup' | 'day' | 'reviews' | 'export';

const NAV: { id: View; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'done', label: 'Done' },
  { id: 'note', label: 'Notes' },
  { id: 'blocker', label: 'Blockers' },
  { id: 'standup', label: 'Standup' },
  { id: 'day', label: 'Day' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'export', label: 'Export' },
];

const COUNT_KINDS: Kind[] = ['plan', 'done', 'note', 'blocker'];

function focusComposer(): boolean {
  const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
  if (el) el.focus();
  return el !== null;
}

export function App() {
  const [view, setView] = useState<View>('standup');
  const [counts, setCounts] = useState<Record<Kind, number>>({
    plan: 0,
    done: 0,
    note: 0,
    blocker: 0,
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const pendingComposerFocus = useRef(false);

  useEffect(() => {
    const today = todayISO();
    const tomorrow = shiftDay(today, 1);
    Promise.all(
      COUNT_KINDS.map((k) =>
        api.list(
          k === 'blocker'
            ? { kind: k, status: 'open', pageSize: 1 }
            : { kind: k, from: today, to: tomorrow, pageSize: 1 },
        ),
      ),
    ).then((results) => {
      const next: Record<Kind, number> = { plan: 0, done: 0, note: 0, blocker: 0 };
      COUNT_KINDS.forEach((k, i) => {
        next[k] = results[i].total;
      });
      setCounts(next);
    });
  }, [refreshKey]);

  // Global shortcuts: 1-8 switch views, n jumps to the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t.isContentEditable
      ) {
        return;
      }
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < NAV.length) {
        setView(NAV[idx].id);
        return;
      }
      if (e.key === 'n') {
        e.preventDefault();
        if (!focusComposer()) {
          // Current view has no composer — go to Plan and focus once it mounts.
          pendingComposerFocus.current = true;
          setView('plan');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (pendingComposerFocus.current) {
      pendingComposerFocus.current = false;
      requestAnimationFrame(() => focusComposer());
    }
  }, [view]);

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Daybook</h1>
        {NAV.map((n, i) => (
          <button
            key={n.id}
            className={`nav-item ${view === n.id ? 'active' : ''}`}
            onClick={() => setView(n.id)}
            title={`${n.label} — press ${i + 1}`}
          >
            <span className="nav-label">
              {COUNT_KINDS.includes(n.id as Kind) && <span className={`kind-dot kind-dot-${n.id}`} />}
              {n.label}
            </span>
            {COUNT_KINDS.includes(n.id as Kind) && counts[n.id as Kind] > 0 ? (
              <span className="count">
                {counts[n.id as Kind]}
                {n.id === 'blocker' ? ' open' : ' today'}
              </span>
            ) : null}
          </button>
        ))}
        <div className="sidebar-footer">
          <div className="sidebar-hint">
            <kbd>1</kbd>–<kbd>8</kbd> views · <kbd>n</kbd> new entry
          </div>
          <a
            className="sidebar-link"
            href="/agents.md"
            target="_blank"
            rel="noreferrer"
            title="Full API contract for AI agents"
          >
            For AI agents →
          </a>
          <a
            className="sidebar-link sidebar-link-faint"
            href="/llms.txt"
            target="_blank"
            rel="noreferrer"
            title="Discovery entry (llmstxt.org)"
          >
            /llms.txt
          </a>
        </div>
      </aside>
      <main className="main">
        {view === 'standup' ? (
          <StandupView onChange={bump} />
        ) : view === 'day' ? (
          <DayView onChange={bump} />
        ) : view === 'reviews' ? (
          <ReviewsView />
        ) : view === 'export' ? (
          <ExportView />
        ) : view === 'plan' || view === 'done' || view === 'note' ? (
          <KindDayView kind={view} onChange={bump} />
        ) : (
          <EntryList kind={view} onChange={bump} />
        )}
      </main>
    </div>
  );
}
