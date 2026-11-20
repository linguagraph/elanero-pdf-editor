// The toast region (W1.6 section 10). It is always in the page so screen readers have a live region
// to announce into. Info and success toasts time out unless the pointer is over the region or
// keyboard focus is inside it; errors wait for the user.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { timesOut, toastDuration, toasts, useToasts, type ToastStore } from './toasts';
import './feedback.css';

export function ToastRegion({ store = toasts }: { store?: ToastStore }) {
  const { visible } = useToasts(store);
  const [paused, setPaused] = useState(false);

  // The timers are keyed on the ids and durations of the timed toasts, not on the list, so a new
  // toast does not restart the clocks of the ones already on screen.
  const timedKey = visible
    .filter((toast) => timesOut(toast.kind))
    .map((toast) => `${toast.id}:${toastDuration(toast)}`)
    .join(' ');

  // One timer per toast, kept across renders: when another toast leaves, the timers of the toasts
  // still on screen keep running. Pausing clears them all, so leaving restarts each from full.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    const wanted = new Map<number, number>();
    if (!paused && timedKey !== '') {
      for (const pair of timedKey.split(' ')) {
        const [id, duration] = pair.split(':');
        wanted.set(Number(id), Number(duration));
      }
    }
    for (const [id, timer] of pending) {
      if (!wanted.has(id)) {
        clearTimeout(timer);
        pending.delete(id);
      }
    }
    for (const [id, duration] of wanted) {
      if (pending.has(id)) continue;
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id);
          store.dismiss(id);
        }, duration),
      );
    }
  }, [timedKey, paused, store]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <section
      className="toast-region"
      aria-label={t('toast.region')}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      {visible.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          data-kind={toast.kind}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-text">{toast.text}</span>
          {toast.action === undefined ? null : (
            <button
              type="button"
              className="toast-action"
              aria-label={t('toast.actionNamed', { action: toast.action.label, text: toast.text })}
              onClick={() => {
                toast.action?.run();
                store.dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-dismiss"
            aria-label={t('toast.dismissNamed', { text: toast.text })}
            onClick={() => store.dismiss(toast.id)}
          >
            {t('toast.dismiss')}
          </button>
        </div>
      ))}
    </section>
  );
}
