import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type StandupResponse, type StandupSections } from './api';

type SectionKey = 'yesterday' | 'today' | 'blockers';

const SECTION_META: Record<SectionKey, { label: string; addLabel: string }> = {
  yesterday: { label: 'Yesterday', addLabel: 'Add a yesterday item' },
  today: { label: 'Today', addLabel: 'Add a planned task' },
  blockers: { label: 'Blockers', addLabel: 'Add a blocker' },
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

function formatShortDate(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function StandupView({ onChange }: { onChange: () => void }) {
  const [date, setDate] = useState<string>(todayISO());
  const [response, setResponse] = useState<StandupResponse | null>(null);
  const [draft, setDraft] = useState<StandupSections | null>(null);
  const [prevDate, setPrevDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState(false);
  const focusKeyRef = useRef<string | null>(null);

  const load = useCallback(
    async (forDate: string) => {
      setLoading(true);
      try {
        const r = await api.standup(forDate);
        setResponse(r);
        setDraft(r.sections);
        setPrevDate(r.prevDate ?? shiftDay(forDate, -1));
        setDirty(false);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    load(date);
  }, [date, load]);

  const isToday = date === todayISO();
  const locked = response?.locked ?? false;

  const updateLine = (section: SectionKey, index: number, value: string) => {
    setDraft((s) => (s ? { ...s, [section]: replaceAt(s[section], index, value) } : s));
    setDirty(true);
  };

  const deleteLine = (section: SectionKey, index: number) => {
    setDraft((s) => (s ? { ...s, [section]: s[section].filter((_, i) => i !== index) } : s));
    setDirty(true);
  };

  const addLine = (section: SectionKey) => {
    focusKeyRef.current = `${section}:new`;
    setDraft((s) => (s ? { ...s, [section]: [...s[section], ''] } : s));
    setDirty(true);
  };

  // Re-pull only the "yesterday" section from a different source day, leaving
  // the user's today/blockers edits untouched.
  const changeYesterdaySource = async (newPrev: string) => {
    const r = await api.standup(date, newPrev);
    setDraft((s) => (s ? { ...s, yesterday: r.sections.yesterday } : s));
    setPrevDate(r.prevDate ?? newPrev);
    setDirty(true);
  };

  const submit = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api.saveStandup(date, draft);
      setResponse(r);
      setDraft(r.sections);
      setDirty(false);
      onChange();
    } finally {
      setSaving(false);
    }
  };

  const repull = async () => {
    setSaving(true);
    try {
      if (locked) {
        await api.unlockStandup(date);
      }
      await load(date);
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!draft) return;
    await navigator.clipboard.writeText(formatStandup(draft));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const status = useMemo(() => {
    if (!response) return null;
    if (response.locked) {
      const when = response.updatedAt ?? response.submittedAt;
      return when ? `Submitted · ${formatTime(when)}` : 'Submitted';
    }
    return 'Live preview · not submitted';
  }, [response]);

  if (loading || !draft || !response) {
    return (
      <div>
        <h2>Standup</h2>
        <div className="empty">Loading...</div>
      </div>
    );
  }

  return (
    <div className="standup">
      <div className="standup-header-row">
        <h2>Standup</h2>
        <div className="standup-actions">
          <button onClick={copy}>{copied ? 'Copied!' : 'Copy for Slack'}</button>
        </div>
      </div>

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

      <div className={`standup-status ${locked ? 'is-locked' : 'is-live'}`}>
        <span>{status}</span>
        <div className="standup-status-actions">
          {locked || dirty ? (
            <button className="ghost small" onClick={repull} disabled={saving}>
              {locked ? 'Unlock & re-pull from entries' : 'Reset to entries'}
            </button>
          ) : null}
          <button onClick={submit} disabled={saving || (locked && !dirty)}>
            {saving
              ? 'Saving…'
              : locked
                ? dirty
                  ? 'Save edits'
                  : 'Saved'
                : 'Submit standup'}
          </button>
        </div>
      </div>

      {(['yesterday', 'today', 'blockers'] as SectionKey[]).map((key) => (
        <Section
          key={key}
          sectionKey={key}
          label={SECTION_META[key].label}
          addLabel={SECTION_META[key].addLabel}
          items={draft[key]}
          onUpdate={(i, v) => updateLine(key, i, v)}
          onDelete={(i) => deleteLine(key, i)}
          onAdd={() => addLine(key)}
          focusKey={focusKeyRef.current}
          clearFocus={() => (focusKeyRef.current = null)}
          source={
            key === 'yesterday' && !locked && prevDate
              ? {
                  date: prevDate,
                  max: shiftDay(date, -1),
                  onChange: changeYesterdaySource,
                }
              : null
          }
        />
      ))}

      <details className="standup-preview">
        <summary>Preview</summary>
        <pre>{formatStandup(draft)}</pre>
      </details>
    </div>
  );
}

interface SectionSource {
  date: string;
  max: string;
  onChange: (date: string) => void;
}

function Section({
  sectionKey,
  label,
  addLabel,
  items,
  onUpdate,
  onDelete,
  onAdd,
  focusKey,
  clearFocus,
  source,
}: {
  sectionKey: SectionKey;
  label: string;
  addLabel: string;
  items: string[];
  onUpdate: (index: number, value: string) => void;
  onDelete: (index: number) => void;
  onAdd: () => void;
  focusKey: string | null;
  clearFocus: () => void;
  source?: SectionSource | null;
}) {
  return (
    <div className={`section section-${sectionKey}`}>
      <div className="section-head">
        <h3>{label}</h3>
        {source && (
          <label className="section-source" title="Pick which day's done items to pull in">
            <span className="section-source-label">from {formatShortDate(source.date)}</span>
            <input
              type="date"
              className="standup-date-picker"
              value={source.date}
              max={source.max}
              onChange={(e) => {
                if (e.target.value && e.target.value <= source.max) source.onChange(e.target.value);
              }}
            />
          </label>
        )}
      </div>
      {items.length === 0 ? (
        <div className="section-empty">(nothing yet)</div>
      ) : (
        <ul className="bullets">
          {items.map((item, i) => (
            <li key={i}>
              <span className="bullet-dot">•</span>
              <input
                type="text"
                value={item}
                ref={(el) => {
                  if (el && focusKey === `${sectionKey}:new` && i === items.length - 1) {
                    el.focus();
                    clearFocus();
                  }
                }}
                onChange={(e) => onUpdate(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onAdd();
                  } else if (e.key === 'Backspace' && item === '') {
                    e.preventDefault();
                    onDelete(i);
                  }
                }}
              />
              <button
                className="bullet-remove"
                onClick={() => onDelete(i)}
                title="Remove line"
                aria-label="Remove line"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <button className="ghost small" onClick={onAdd}>
        + {addLabel}
      </button>
    </div>
  );
}

function replaceAt(xs: string[], i: number, v: string): string[] {
  const out = xs.slice();
  out[i] = v;
  return out;
}

function formatStandup(s: StandupSections): string {
  const bullets = (xs: string[]) => {
    const clean = xs.map((x) => x.trim()).filter(Boolean);
    return clean.length ? clean.map((x) => `- ${x}`).join('\n') : '- (nothing)';
  };
  return [
    `*Yesterday*\n${bullets(s.yesterday)}`,
    `*Today*\n${bullets(s.today)}`,
    `*Blockers*\n${bullets(s.blockers)}`,
  ].join('\n\n');
}
