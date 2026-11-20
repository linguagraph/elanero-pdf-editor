// What the user sees after a save (W4.8): a toast for each outcome, worded through t(). The
// downloads keep their bytes in the toast's action, so the user can download the same file again;
// the bytes go when the toast does.
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { SaveOutcome } from './saver';

export function reportSaveOutcome(
  outcome: SaveOutcome,
  download: (name: string, data: ArrayBuffer) => void,
  store: ToastStore = toasts,
): void {
  switch (outcome.status) {
    case 'saved': {
      const again = {
        label: t('action.downloadAgain'),
        run: () => {
          download(outcome.name, outcome.data);
        },
      };
      const text = outcome.incremental ? 'save.downloadedSigned' : 'save.downloaded';
      store.push('success', t(text, { name: outcome.name }), again);
      if (outcome.changedSince) store.push('info', t('save.changedSince'));
      return;
    }
    case 'failed':
      // A save of a signed document that the engine refused gets the "save as a new file" wording
      // through the context (W4.8); the Save As action joins it with W4.9.
      reportRpcError(store, outcome.error, outcome.context);
      return;
    case 'download-blocked':
      store.push('warning', t('save.downloadBlocked', { name: outcome.name }), {
        label: t('action.download'),
        run: () => {
          download(outcome.name, outcome.data);
        },
      });
      return;
    case 'skipped':
      // A second save of the same document while one runs is already on its way: nothing to say.
      if (outcome.reason === 'signed-restored') {
        store.push('warning', t('save.signedRestored'));
      }
      return;
  }
}
