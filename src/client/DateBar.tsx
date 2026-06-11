import { useRef } from 'react';
import { formatDateLabel, shiftDay, todayISO } from './dates';

export function DateBar({ date, onChange }: { date: string; onChange: (d: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isToday = date === todayISO();

  const openPicker = () => {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') el.showPicker();
    else el.focus();
  };

  return (
    <div className="datebar">
      <div className="datebar-nav">
        <button
          className="ghost icon-nav"
          onClick={() => onChange(shiftDay(date, -1))}
          title="Previous day"
          aria-label="Previous day"
        >
          ‹
        </button>
        <button
          className="ghost icon-nav"
          onClick={() => onChange(shiftDay(date, 1))}
          disabled={isToday}
          title={isToday ? 'No future dates' : 'Next day'}
          aria-label="Next day"
        >
          ›
        </button>
      </div>
      <span className="datebar-anchor">
        <button className="datebar-label" onClick={openPicker} title="Jump to a date">
          {formatDateLabel(date)}
          <span className="datebar-caret">▾</span>
        </button>
        <input
          ref={inputRef}
          type="date"
          className="datebar-input"
          value={date}
          max={todayISO()}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
          }}
          tabIndex={-1}
          aria-hidden="true"
        />
      </span>
      {!isToday && (
        <button className="ghost small" onClick={() => onChange(todayISO())}>
          Today
        </button>
      )}
    </div>
  );
}
