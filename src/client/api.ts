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

export interface StandupResponse {
  yesterdayDone: Entry[];
  todayPlan: Entry[];
  openBlockers: Entry[];
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
  standup() {
    return fetch('/api/standup').then(json<StandupResponse>);
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
