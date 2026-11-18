// The update banner (W4.6). It shows only when a new version is waiting, as a status region so
// screen readers announce it once without taking focus.
import { useSyncExternalStore } from 'react';
import { t } from '../i18n/t';
import { applyWaitingWorker, getWaitingWorker, subscribeUpdates } from './update';

export function UpdatePrompt() {
  const worker = useSyncExternalStore(subscribeUpdates, getWaitingWorker, getWaitingWorker);
  if (worker === undefined) return null;
  const container = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
  return (
    <div className="update-banner" role="status">
      <span>{t('update.ready')}</span>
      <button
        type="button"
        onClick={() => applyWaitingWorker(container, () => globalThis.location.reload())}
      >
        {t('update.reload')}
      </button>
    </div>
  );
}
