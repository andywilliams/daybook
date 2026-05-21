export type Kind = 'done' | 'plan' | 'note' | 'blocker';
export type Status = 'open' | 'resolved';

export interface Entry {
  id: number;
  kind: Kind;
  content: string;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface ListResponse {
  rows: Entry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface StandupSections {
  yesterday: string[];
  today: string[];
  blockers: string[];
}

export interface StandupResponse {
  date: string;
  sections: StandupSections;
  locked: boolean;
  submittedAt?: string;
  updatedAt?: string;
}

export interface StandupHistoryRow {
  date: string;
  submitted_at: string;
  updated_at: string;
}

export type ReviewPeriod = 'week' | 'month' | 'quarter';

export interface StatTile {
  label: string;
  value: string | number;
  sublabel?: string;
}

export interface BarChart {
  type: 'bar';
  title: string;
  data: { label: string; value: number }[];
}

export type ReviewSection =
  | { kind: 'themes'; title?: string; items: { title: string; body: string }[] }
  | { kind: 'wins'; title?: string; items: string[] }
  | { kind: 'stuck'; title?: string; items: { title: string; body: string }[] }
  | { kind: 'people'; title?: string; items: { name: string; count: number; note?: string }[] }
  | { kind: 'tickets'; title?: string; items: { id: string; count: number; note?: string }[] }
  | { kind: 'prose'; title?: string; body: string };

export interface ReviewContent {
  headline: string;
  summary: string;
  stats: StatTile[];
  charts?: BarChart[];
  sections: ReviewSection[];
}

export interface Review {
  id: number;
  period: ReviewPeriod;
  from_date: string;
  to_date: string;
  content: ReviewContent;
  created_at: string;
  updated_at: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  list(params: {
    kind?: Kind;
    q?: string;
    status?: Status;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '' && v !== null) sp.set(k, String(v));
    });
    return fetch(`/api/entries?${sp}`).then(json<ListResponse>);
  },
  create(kind: Kind, content: string) {
    return fetch('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, content }),
    }).then(json<Entry>);
  },
  update(id: number, patch: { content?: string; status?: Status }) {
    return fetch(`/api/entries/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(json<Entry>);
  },
  remove(id: number) {
    return fetch(`/api/entries/${id}`, { method: 'DELETE' }).then(json<void>);
  },
  standup(date?: string) {
    const sp = new URLSearchParams();
    if (date) sp.set('date', date);
    const qs = sp.toString();
    return fetch(`/api/standup${qs ? `?${qs}` : ''}`).then(json<StandupResponse>);
  },
  saveStandup(date: string, sections: StandupSections) {
    return fetch('/api/standup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, sections }),
    }).then(json<StandupResponse>);
  },
  unlockStandup(date: string) {
    return fetch(`/api/standup/${date}`, { method: 'DELETE' }).then(json<void>);
  },
  standupHistory(limit?: number) {
    const sp = new URLSearchParams();
    if (limit) sp.set('limit', String(limit));
    const qs = sp.toString();
    return fetch(`/api/standup/history${qs ? `?${qs}` : ''}`).then(json<{ rows: StandupHistoryRow[] }>);
  },
  reviews(period?: ReviewPeriod, limit?: number) {
    const sp = new URLSearchParams();
    if (period) sp.set('period', period);
    if (limit) sp.set('limit', String(limit));
    const qs = sp.toString();
    return fetch(`/api/reviews${qs ? `?${qs}` : ''}`).then(json<{ rows: Review[] }>);
  },
  review(id: number) {
    return fetch(`/api/reviews/${id}`).then(json<Review>);
  },
  createReview(payload: {
    period: ReviewPeriod;
    from: string;
    to: string;
    content: ReviewContent;
  }) {
    return fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(json<Review>);
  },
  deleteReview(id: number) {
    return fetch(`/api/reviews/${id}`, { method: 'DELETE' }).then(json<void>);
  },
  exportData(params: { range?: 'week' | 'month'; from?: string; to?: string }) {
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) sp.set(k, String(v));
    });
    return fetch(`/api/export?${sp}`).then(json<{
      exportedAt: string;
      range: { range: string | null; from: string | null; to: string | null };
      count: number;
      entries: Entry[];
    }>);
  },
  exportUrl(params: { range?: 'week' | 'month'; from?: string; to?: string }) {
    const sp = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) sp.set(k, String(v));
    });
    sp.set('download', '1');
    return `/api/export?${sp}`;
  },
};
