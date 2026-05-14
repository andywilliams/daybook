import { useEffect, useState } from 'react';
import { api, type StandupResponse } from './api';

export function StandupView() {
  const [data, setData] = useState<StandupResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.standup().then(setData);
  }, []);

  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!data) return <div className="empty">Loading...</div>;

  return (
    <div className="standup">
      <h2>Standup</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Generated from yesterday's done items, today's done items, open blockers, and today's notes.
      </p>
      <pre>{data.text}</pre>
      <div className="row">
        <button onClick={copy}>{copied ? 'Copied!' : 'Copy to clipboard'}</button>
        <button className="ghost" onClick={() => api.standup().then(setData)}>
          Refresh
        </button>
      </div>
    </div>
  );
}
