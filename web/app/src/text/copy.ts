// Copy and Select All over the page text (W5.4 S4, W1.4 section 10). The selection is the browser's
// own, over the page text layers: selection.ts maps it to the chars it covers, so the text copied is
// the chars of each page in reading order, lines joined by a line break, as the desktop copies. Pages
// are joined the same way. Nothing here changes the document.
import { toasts, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { LINE_SEP } from './pageTextIndex';
import { domSelectionAreas, type TextLineLookup } from './selection';

// The most text one copy takes (W1.4 section 10, decision D4): a larger selection is refused with a
// message, never cut short, so the clipboard never gets part of what was selected.
export const MAX_COPY_CHARS = 50 * 1024 * 1024;

export interface CopyDeps {
  // The window's selection, or null when there is none to read.
  readonly selection: Selection | null;
  // The text lines of a page as they are shown (the view's cachedLines).
  readonly lookup: TextLineLookup;
  readonly clipboard: Pick<Clipboard, 'writeText'> | undefined;
  readonly store?: Pick<ToastStore, 'push'>;
}

// The selected text, or '' when nothing selected has text. Each page's selected lines are joined by
// a line break, and so are the pages (the desktop's TextSelection.text).
export function selectedText(selection: Selection | null, lookup: TextLineLookup): string {
  return domSelectionAreas(selection, lookup)
    .map((area) => area.text)
    .join(LINE_SEP);
}

// Copies the selection to the clipboard. It runs synchronously up to the clipboard call, so the
// browser still counts it as the user's keypress or click (Firefox and Safari require that).
export function copySelectedText(deps: CopyDeps): void {
  const store = deps.store ?? toasts;
  const text = selectedText(deps.selection, deps.lookup);
  if (text === '') {
    store.push('info', t('copy.nothingSelected'));
    return;
  }
  if (text.length > MAX_COPY_CHARS) {
    store.push('info', t('copy.tooLarge'));
    return;
  }
  if (deps.clipboard === undefined) {
    store.push('error', t('copy.failed'));
    return;
  }
  deps.clipboard.writeText(text).then(
    () => store.push('success', t('copy.done')),
    () => store.push('error', t('copy.failed')),
  );
}

// Selects everything in one page's text layer, so Copy and Mark Text read it as they would a drag
// over the page. A page with no text layer (or no selection to set) selects nothing.
export function selectPageText(selection: Selection | null, layer: Element | null): void {
  if (selection === null || layer === null) return;
  const range = layer.ownerDocument.createRange();
  range.selectNodeContents(layer);
  selection.removeAllRanges();
  selection.addRange(range);
}
