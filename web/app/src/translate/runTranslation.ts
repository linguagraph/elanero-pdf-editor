// The translation bubble's logic (W6.6 section 8), with no React: one translation.translate call,
// the default languages, the selection read and Add as note. The request is sent only here, after
// the consent check in TranslateFlow. Only the selected text goes in the call; nothing is logged.
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { MAX_COPY_CHARS } from '../text/copy';
import { RpcError } from '../rpc/client';
import type { TranslateParams, TranslateResult } from '../rpc/generated';
import { domSelectionAreas, type ModelRead, type TextLineLookup } from '../text/selection';
import type { PageArea } from '../text/textLayer';
import type { RenderScheduler } from '../view/renderScheduler';
import { readPreferences } from '../prefs/store';

// The main thread's cap on the raw text (W6.6 section 6): a select-all never crosses to the worker.
export const MAX_TRANSLATE_CHARS = 40_000;

// The selection as the bubble keeps it: the text and the page areas it was read from.
export interface SelectionSnapshot {
  readonly text: string;
  readonly areas: readonly PageArea[];
}

// The engine call, as the flow passes it in (translation.translate on the engine worker).
export type TranslateCall = (params: TranslateParams) => Promise<TranslateResult>;

export type TranslateOutcome =
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly error: RpcError; readonly partial: string };

// Reads the selection the way Mark Text does: the model's when it is ready and not empty, else the
// browser's (under the Hand tool). Null when there is no text selected.
export function readSelection(
  model: () => ModelRead<PageArea[]>,
  selection: Selection | null,
  lookup: TextLineLookup,
): SelectionSnapshot | null {
  const read = model();
  const modelAreas = read.state === 'ready' ? read.value : [];
  const areas = modelAreas.length > 0 ? modelAreas : domSelectionAreas(selection, lookup);
  const text = areas
    .map((area) => area.text)
    .join('\n')
    .trim();
  return text === '' ? null : { text, areas };
}

// The From and To defaults (W6.6 section 8). From: the last source the user chose, else English;
// To: the saved target, else English, else the first language that differs from From. Only codes
// MyMemory lists are chosen, and From never gets a "detect" entry (MyMemory cannot detect).
export function defaultLanguages(
  codes: readonly string[],
  prefs: { readonly translationTarget: string; readonly translationLastSource: string },
): { readonly source: string; readonly target: string } {
  const source = [prefs.translationLastSource, 'en'].find((c) => codes.includes(c)) ?? codes[0];
  const first = source ?? '';
  const target =
    [prefs.translationTarget, 'en'].find((c) => c !== first && codes.includes(c)) ??
    codes.find((c) => c !== first) ??
    '';
  return { source: first, target };
}

// Runs one translation. Too long a text and an offline browser are refused before any call; a
// failed call keeps the text it translated before it stopped (details.partial).
export async function runTranslation(
  call: TranslateCall,
  request: { readonly text: string; readonly source: string; readonly target: string },
): Promise<TranslateOutcome> {
  if (request.text.length > MAX_TRANSLATE_CHARS) {
    return { kind: 'failed', error: new RpcError('TRANSLATION_TOO_LONG', ''), partial: '' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { kind: 'failed', error: new RpcError('TRANSLATION_OFFLINE', ''), partial: '' };
  }
  try {
    const result = await call(request);
    return { kind: 'done', text: result.text };
  } catch (error) {
    const rpcError =
      error instanceof RpcError ? error : new RpcError('TRANSLATION_SERVICE', String(error));
    const partial = rpcError.details.partial;
    return {
      kind: 'failed',
      error: rpcError,
      partial: typeof partial === 'string' ? partial : '',
    };
  }
}

// One rectangle per line of a quad (the highlight takes rectangles): the quad's box, in page points.
function rectsOf(area: PageArea): { x0: number; y0: number; x1: number; y1: number }[] {
  return area.quads.map((quad) => ({
    x0: Math.min(quad.ul.x, quad.ll.x),
    y0: Math.min(quad.ul.y, quad.ur.y),
    x1: Math.max(quad.ur.x, quad.lr.x),
    y1: Math.max(quad.ll.y, quad.lr.y),
  }));
}

export interface NoteDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
}

// Add as note (W6.6 section 9): one highlight per page over the selection, with the translation as
// its note, through the engine's action layer. One undo step, as the desktop's.
export async function addTranslationNote(
  deps: NoteDeps,
  areas: readonly PageArea[],
  note: string,
): Promise<void> {
  const store = deps.store ?? toasts;
  const pages = areas.map((area) => ({ page: area.page, rects: rectsOf(area) }));
  try {
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.highlight_text',
      // The author is read now, so a changed name applies to this note (as Add Note does).
      args: { pages, note, author: readPreferences().authorName },
    });
    if (!reply.executed) return;
    deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
    offerUndo('info', t('translate.noteAdded'), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      onUndone: (undone) => deps.scheduler.noteRevisions(undone.changed?.revisions ?? {}),
      store,
    });
  } catch (error) {
    if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('comment.failed'));
  }
}

// Copies the translation or the selected text. A text over the Copy cap is refused, as Copy does.
export function copyText(text: string, store: ToastStore = toasts): void {
  if (text.length > MAX_COPY_CHARS) {
    store.push('info', t('copy.tooLarge'));
    return;
  }
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    store.push('error', t('copy.failed'));
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => store.push('success', t('copy.done')),
    () => store.push('error', t('copy.failed')),
  );
}
