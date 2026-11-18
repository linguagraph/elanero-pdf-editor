// The toast region (W1.6 section 10). It is always in the page so screen readers have a live region
// to announce into. Info and success toasts time out unless the pointer is over the region or
// keyboard focus is inside it; errors wait for the user.
import { useEffect, useState } from 'react';
import { t } from '../i18n/t';
import { AUTO_DISMISS_MS, timesOut, toasts, useToasts, type ToastStore } from './toasts';
import './feedback.css';

export function ToastRegion({ store = toasts }: { store?: ToastStore }) {
  const { visible } = useToasts(store);
  const [paused, setPaused] = useState(false);

  // The timers are keyed on the ids of the timed toasts, not on the list, so a new toast does not
  // restart the clocks of the ones already on screen.
  const timedKey = visible
    .filter((toast) => timesOut(toast.kind))
    .map((toast) => toast.id)
    .join(' ');

  useEffect(() => {
    if (paused || timedKey === '') return undefined;
    const timers = timedKey
      .split(' ')
      .map((id) => setTimeout(() => store.dismiss(Number(id)), AUTO_DISMISS_MS));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [timedKey, paused, store]);

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
