import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BarChart,
  type Review,
  type ReviewContent,
  type ReviewPeriod,
  type ReviewSection,
  type StatTile,
} from './api';

const PERIOD_LABEL: Record<ReviewPeriod, string> = {
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
};

function formatDateLabel(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ReviewsView() {
  const [filter, setFilter] = useState<'all' | ReviewPeriod>('all');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.reviews(filter === 'all' ? undefined : filter, 365);
      setReviews(r.rows);
      setIndex(0);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (id: number) => {
    if (!confirm('Delete this review?')) return;
    await api.deleteReview(id);
    load();
  };

  const total = reviews.length;
  const safeIndex = Math.min(index, Math.max(0, total - 1));
  const current = total > 0 ? reviews[safeIndex] : null;
  const atNewest = safeIndex === 0;
  const atOldest = safeIndex >= total - 1;

  return (
    <div className="reviews">
      <div className="standup-header-row">
        <h2>Reviews</h2>
      </div>

      <div className="day-filterbar">
        <button
          className={`chip ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          <span>All</span>
        </button>
        {(['week', 'month', 'quarter'] as ReviewPeriod[]).map((p) => (
          <button
            key={p}
            className={`chip ${filter === p ? 'active' : ''}`}
            onClick={() => setFilter(p)}
          >
            <span>{PERIOD_LABEL[p]}</span>
          </button>
        ))}
      </div>

      {total > 0 && (
        <div className="datebar">
          <div className="datebar-nav">
            <button
              className="ghost icon-nav"
              onClick={() => setIndex(safeIndex + 1)}
              disabled={atOldest}
              title={atOldest ? 'No older reviews' : 'Older review'}
              aria-label="Older review"
            >
              ‹
            </button>
            <button
              className="ghost icon-nav"
              onClick={() => setIndex(safeIndex - 1)}
              disabled={atNewest}
              title={atNewest ? 'No newer reviews' : 'Newer review'}
              aria-label="Newer review"
            >
              ›
            </button>
          </div>
          <span className="datebar-static">
            {safeIndex + 1} of {total}
          </span>
          {!atNewest && (
            <button className="ghost small" onClick={() => setIndex(0)}>
              Latest
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="empty">Loading...</div>
      ) : !current ? (
        <div className="empty">
          No reviews yet. Hand Claude a fresh export and ask for one — it'll POST to <code>/api/reviews</code>.
        </div>
      ) : (
        <div className="reviews-list">
          <ReviewCard review={current} onDelete={() => remove(current.id)} />
        </div>
      )}
    </div>
  );
}

function ReviewCard({ review, onDelete }: { review: Review; onDelete: () => void }) {
  const { content } = review;
  return (
    <article className="review-card">
      <header className="review-head">
        <div className="review-meta">
          <span className={`review-period review-period-${review.period}`}>
            {PERIOD_LABEL[review.period]}
          </span>
          <span className="review-range">
            {formatDateLabel(review.from_date)} → {formatDateLabel(review.to_date)}
          </span>
          {review.updated_at && review.updated_at !== review.created_at ? (
            <span className="review-stamp" title={`Created ${review.created_at}`}>
              Updated {formatTimestamp(review.updated_at)}
            </span>
          ) : review.created_at ? (
            <span className="review-stamp">Generated {formatTimestamp(review.created_at)}</span>
          ) : null}
        </div>
        <button className="ghost small" onClick={onDelete} title="Delete this review">
          ✕
        </button>
      </header>

      <h3 className="review-headline">{content.headline}</h3>
      {content.summary && <p className="review-summary">{content.summary}</p>}

      {content.stats.length > 0 && (
        <div className="review-stats">
          {content.stats.map((s, i) => (
            <StatBlock key={i} stat={s} />
          ))}
        </div>
      )}

      {content.charts?.map((c, i) => (
        <ChartBlock key={i} chart={c} />
      ))}

      <div className="review-sections">
        {content.sections.map((s, i) => (
          <SectionBlock key={i} section={s} />
        ))}
      </div>
    </article>
  );
}

function StatBlock({ stat }: { stat: StatTile }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{stat.value}</div>
      <div className="stat-label">{stat.label}</div>
      {stat.sublabel && <div className="stat-sublabel">{stat.sublabel}</div>}
    </div>
  );
}

function ChartBlock({ chart }: { chart: BarChart }) {
  const max = Math.max(1, ...chart.data.map((d) => d.value));
  return (
    <div className="review-chart">
      <h4 className="review-chart-title">{chart.title}</h4>
      <div className="bars">
        {chart.data.map((d, i) => (
          <div key={i} className="bar-row">
            <div className="bar-label">{d.label}</div>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${(d.value / max) * 100}%` }}
                title={String(d.value)}
              />
            </div>
            <div className="bar-value">{d.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionBlock({ section }: { section: ReviewSection }) {
  switch (section.kind) {
    case 'wins':
      return (
        <Section title={section.title ?? 'Wins'} kind="wins">
          <ul className="bullets-static">
            {section.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </Section>
      );
    case 'themes':
    case 'stuck':
      return (
        <Section title={section.title ?? (section.kind === 'themes' ? 'Themes' : 'Stuck')} kind={section.kind}>
          <div className="theme-list">
            {section.items.map((item, i) => (
              <div key={i} className="theme-item">
                <div className="theme-title">{item.title}</div>
                <div className="theme-body">{item.body}</div>
              </div>
            ))}
          </div>
        </Section>
      );
    case 'people':
      return (
        <Section title={section.title ?? 'People'} kind="people">
          <div className="entity-chips">
            {section.items.map((item, i) => (
              <div key={i} className="entity-chip" title={item.note}>
                <span className="entity-name">{item.name}</span>
                <span className="entity-count">{item.count}</span>
                {item.note && <span className="entity-note">{item.note}</span>}
              </div>
            ))}
          </div>
        </Section>
      );
    case 'tickets':
      return (
        <Section title={section.title ?? 'Tickets'} kind="tickets">
          <div className="entity-chips">
            {section.items.map((item, i) => (
              <div key={i} className="entity-chip" title={item.note}>
                <span className="entity-name">{item.id}</span>
                <span className="entity-count">{item.count}</span>
                {item.note && <span className="entity-note">{item.note}</span>}
              </div>
            ))}
          </div>
        </Section>
      );
    case 'prose':
      return (
        <Section title={section.title ?? 'Notes'} kind="prose">
          <p className="prose-body">{section.body}</p>
        </Section>
      );
  }
}

function Section({
  title,
  kind,
  children,
}: {
  title: string;
  kind: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`review-section review-section-${kind}`}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}
