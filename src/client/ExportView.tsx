import { useState } from 'react';
import { api, type Entry } from './api';

type Range = 'week' | 'month' | 'custom';

export function ExportView() {
  const [range, setRange] = useState<Range>('week');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<{
    exportedAt: string;
    count: number;
    entries: Entry[];
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const params = (): { range?: 'week' | 'month'; from?: string; to?: string } => {
    if (range === 'custom') return { from: from || undefined, to: to || undefined };
    return { range };
  };

  const runPreview = async () => {
    setLoading(true);
    try {
      const data = await api.exportData(params());
      setPreview(data);
    } finally {
      setLoading(false);
    }
  };

  const downloadHref = api.exportUrl(params());

  return (
    <div>
      <h2>Export</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Download a JSON dump of your entries to feed to an AI agent for theme extraction.
      </p>

      <div className="export-card">
        <div className="row">
          <div>
            <label>Range</label>
            <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
              <option value="week">Last 7 days</option>
              <option value="month">Last month</option>
              <option value="custom">Custom dates</option>
            </select>
          </div>
          {range === 'custom' && (
            <>
              <div>
                <label>From</label>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label>To (exclusive)</label>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="ghost" onClick={runPreview} disabled={loading}>
              {loading ? 'Loading...' : 'Preview'}
            </button>
            <a href={downloadHref}>
              <button>Download JSON</button>
            </a>
          </div>
        </div>
      </div>

      {preview && (
        <>
          <div style={{ color: 'var(--muted)', marginBottom: 8 }}>
            {preview.count} {preview.count === 1 ? 'entry' : 'entries'} · exported{' '}
            {new Date(preview.exportedAt).toLocaleString()}
          </div>
          <div className="export-preview">{JSON.stringify(preview, null, 2)}</div>
        </>
      )}
    </div>
  );
}
