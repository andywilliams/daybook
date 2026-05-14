import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type StandupResponse } from './api';

type SectionKey = 'yesterday' | 'today' | 'blockers';

interface Sections {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

const SECTION_META: Record<SectionKey, { label: string; addLabel: string }> = {
  yesterday: { label: 'Yesterday', addLabel: 'Add a yesterday item' },
  today: { label: 'Today', addLabel: 'Add a planned task' },
  blockers: { label: 'Blockers', addLabel: 'Add a blocker' },
};

export function StandupView({ onChange }: { onChange: () => void }) {
  const [sections, setSections] = useState<Sections | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showAddPlan, setShowAddPlan] = useState(false);
  const [planDraft, setPlanDraft] = useState('');
  const focusKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.standup();
      setSections(fromResponse(r));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateLine = (section: SectionKey, index: number, value: string) => {
    setSections((s) => (s ? { ...s, [section]: replaceAt(s[section], index, value) } : s));
  };

  const deleteLine = (section: SectionKey, index: number) => {
    setSections((s) => (s ? { ...s, [section]: s[section].filter((_, i) => i !== index) } : s));
  };

  const addLine = (section: SectionKey) => {
    focusKeyRef.current = `${section}:new`;
    setSections((s) => (s ? { ...s, [section]: [...s[section], ''] } : s));
  };

  const copy = async () => {
    if (!sections) return;
    await navigator.clipboard.writeText(formatStandup(sections));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submitPlan = async () => {
    const content = planDraft.trim();
    if (!content) return;
    await api.create('plan', content);
    setPlanDraft('');
    setShowAddPlan(false);
    onChange();
    load();
  };

  if (loading || !sections) {
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
          <button className="ghost" onClick={load} title="Re-pull from your entries">
            Reset
          </button>
        </div>
      </div>

      <p className="standup-hint">
        Pulled from yesterday's <code>done</code>, today's <code>plan</code>, and open{' '}
        <code>blockers</code>. Edits here are local — they don't change your entries. Use{' '}
        <strong>Reset</strong> to re-pull, or add a plan item that sticks.
      </p>

      {(['yesterday', 'today', 'blockers'] as SectionKey[]).map((key) => (
        <Section
          key={key}
          sectionKey={key}
          label={SECTION_META[key].label}
          addLabel={SECTION_META[key].addLabel}
          items={sections[key]}
          onUpdate={(i, v) => updateLine(key, i, v)}
          onDelete={(i) => deleteLine(key, i)}
          onAdd={() => addLine(key)}
          focusKey={focusKeyRef.current}
          clearFocus={() => (focusKeyRef.current = null)}
          extraControl={
            key === 'today' ? (
              <button
                className="ghost small"
                onClick={() => setShowAddPlan((v) => !v)}
                title="Save as a Plan entry too"
              >
                {showAddPlan ? 'Hide' : '+ Save plan entry'}
              </button>
            ) : null
          }
        />
      ))}

      {showAddPlan && (
        <div className="add-plan">
          <textarea
            value={planDraft}
            onChange={(e) => setPlanDraft(e.target.value)}
            placeholder="Plan item to save (will appear in today's Plan tab)"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submitPlan();
              }
            }}
            autoFocus
          />
          <div className="add-plan-actions">
            <button onClick={submitPlan} disabled={!planDraft.trim()}>
              Save plan
            </button>
            <button
              className="ghost"
              onClick={() => {
                setPlanDraft('');
                setShowAddPlan(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <details className="standup-preview">
        <summary>Preview</summary>
        <pre>{formatStandup(sections)}</pre>
      </details>
    </div>
  );
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
  extraControl,
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
  extraControl?: React.ReactNode;
}) {
  return (
    <div className={`section section-${sectionKey}`}>
      <div className="section-head">
        <h3>{label}</h3>
        {extraControl}
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

function fromResponse(r: StandupResponse): Sections {
  return {
    yesterday: r.yesterdayDone.map((e) => e.content),
    today: r.todayPlan.map((e) => e.content),
    blockers: r.openBlockers.map((e) => e.content),
  };
}

function replaceAt(xs: string[], i: number, v: string): string[] {
  const out = xs.slice();
  out[i] = v;
  return out;
}

function formatStandup(s: Sections): string {
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
