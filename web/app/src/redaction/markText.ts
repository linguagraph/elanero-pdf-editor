// Mark Text (W4.12 S2): marks the browser's text selection as redaction marks, one per page, in one
// undo step. Nothing is applied: the marks wait in the document until the user applies them, as on
// the desktop. The command is enabled with no selection, and then says so.
import { toasts, type ToastStore } from '../feedback/toasts';
import { t, tp } from '../i18n/t';
import { domSelectionAreas, type TextLineLookup } from '../text/selection';
import type { RedactionSnapshot } from './controller';
import type { PageArea } from '../text/textLayer';

export interface MarkTextDeps {
  readonly controller: {
    getSnapshot(): Pick<RedactionSnapshot, 'busy'>;
    markAreas(areas: readonly PageArea[]): Promise<number>;
  };
  // The window's selection, or null when there is none to read.
  readonly selection: Selection | null;
  // The text lines of a page as they are shown (the view's cachedLines).
  readonly lookup: TextLineLookup;
  readonly store?: Pick<ToastStore, 'push'>;
}

// Marks the selected text. Ignored while an apply runs. The selection is cleared once it is marked,
// so a second press does not mark the same text again.
export async function markSelectedText(deps: MarkTextDeps): Promise<void> {
  const store = deps.store ?? toasts;
  if (deps.controller.getSnapshot().busy) return;
  const areas = domSelectionAreas(deps.selection, deps.lookup);
  if (areas.length === 0) {
    store.push('info', t('redact.selectTextFirst'));
    return;
  }
  const added = await deps.controller.markAreas(areas);
  if (added === 0) return;
  deps.selection?.removeAllRanges();
  store.push('success', tp('redact.markedText', added));
}
