// Copy and Select All over the page text (W5.4 S4, W1.4 section 10). The model's selection (a drag,
// or Select All) is read first: its chars are the text copied, the chars of each page in reading
// order, lines joined by a line break, as the desktop copies. Pages are joined the same way. The
// browser's selection is read only when the model is off (the Hand tool, see DocumentView). Nothing
// here changes the document.
import { toasts, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { LINE_SEP, type PageTextIndex } from './pageTextIndex';
import { domSelectionAreas, MODEL_OFF, type ModelRead, type TextLineLookup } from './selection';
import { type PageIndexes, type TextSelection } from './textSelection';

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
  // The model's selection text (readModelText through the view). Its `off` state reads the browser's
  // selection instead; a `ready` one is copied as it is, even when empty (no browser fallback).
  readonly model?: () => ModelRead<string>;
  // Asks for the index of the pages a `loading` read names. Copy cannot wait for them (the clipboard
  // write must stay in the keypress), so the next press finds them.
  readonly loadPages?: (pages: readonly number[]) => Promise<void>;
}

// The selected text, or '' when nothing selected has text. Each page's selected lines are joined by
// a line break, and so are the pages (the desktop's TextSelection.text).
export function selectedText(selection: Selection | null, lookup: TextLineLookup): string {
  return domSelectionAreas(selection, lookup)
    .map((area) => area.text)
    .join(LINE_SEP);
}

// The indexes of every page a model selection covers, or the pages whose index has not arrived. A
// page's index is looked up once; the model never copies part of a selection (decision D4).
export function readModelIndexes(
  selection: TextSelection,
  indexOf: (page: number) => PageTextIndex | undefined,
): ModelRead<PageIndexes> {
  const found = new Map<number, PageTextIndex>();
  const missing: number[] = [];
  for (let page = selection.start.page; page <= selection.end.page; page += 1) {
    const index = indexOf(page);
    if (index === undefined) missing.push(page);
    else found.set(page, index);
  }
  if (missing.length > 0) return { state: 'loading', pages: missing };
  return {
    state: 'ready',
    value: {
      get: (page) => {
        const index = found.get(page);
        if (index === undefined) throw new Error(`no index for page ${page}`);
        return index;
      },
    },
  };
}

// The text of the model's selection, pages joined as the desktop joins them. `ready` with '' when
// nothing is selected (no selection, or an empty one); `loading` when a covered page has no index.
export function readModelText(
  selection: TextSelection | null,
  indexOf: (page: number) => PageTextIndex | undefined,
): ModelRead<string> {
  if (selection === null || selection.isEmpty) return { state: 'ready', value: '' };
  const read = readModelIndexes(selection, indexOf);
  if (read.state !== 'ready') return read;
  return { state: 'ready', value: selection.text(read.value) };
}

// Copies the selection to the clipboard. It runs synchronously up to the clipboard call, so the
// browser still counts it as the user's keypress or click (Firefox and Safari require that).
export function copySelectedText(deps: CopyDeps): void {
  const store = deps.store ?? toasts;
  const read = deps.model?.() ?? MODEL_OFF;
  if (read.state === 'loading') {
    void deps.loadPages?.(read.pages);
    store.push('info', t('text.stillLoading'));
    return;
  }
  const text = read.state === 'ready' ? read.value : selectedText(deps.selection, deps.lookup);
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
