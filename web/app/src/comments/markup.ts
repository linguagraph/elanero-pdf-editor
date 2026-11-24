// Text markup from the selection (W7.1a slice 5): Highlight, Underline, Strikeout and Squiggly mark
// the text selection through annotations.mark_text, one comment per page, in one undo step (the
// desktop's apply_markup). The selection is read as Mark Text reads it: the model's, or the
// browser's under Hand. The web draws nothing here; the engine builds the comments (W1.3).
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { readPreferences } from '../prefs/store';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { domSelectionAreas, type ModelRead, type TextLineLookup } from '../text/selection';
import type { PageArea } from '../text/textLayer';
import { MAX_TEXT_LAYERS } from '../text/textLayerCache';
import type { RenderScheduler } from '../view/renderScheduler';

// The same names as annotations.mark_text's MarkupKind (src/pdfeditor/actions/comment_tools.py).
export type MarkupKind = 'highlight' | 'underline' | 'strikeout' | 'squiggly';

// The ribbon's markup commands and the kind each one marks. Strikethrough is the ribbon's name for
// the engine's Strikeout.
export const MARKUP_COMMAND_KINDS: Readonly<{
  highlight: MarkupKind;
  underline: MarkupKind;
  strikethrough: MarkupKind;
  squiggly: MarkupKind;
}> = {
  highlight: 'highlight',
  underline: 'underline',
  strikethrough: 'strikeout',
  squiggly: 'squiggly',
};

// `marked`: comments were added. `none`: there is no text selected, so nothing was done. `busy`:
// the selection was refused or is still loading, and the user has been told. `failed`: the engine
// refused the markup, and the user has been told. `unmarked`: the engine ran no step for a
// selection that had text, and the user has been told (the failed toast), so it is not "no
// selection".
export type MarkupOutcome = 'marked' | 'none' | 'busy' | 'failed' | 'unmarked';

export interface MarkupDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  // The view's model selection reads, as Mark Text uses them (the Hand tool reads `off`).
  readonly pageSpan: () => number;
  readonly model: () => ModelRead<PageArea[]>;
  readonly clearModel: () => void;
  readonly loadPages: (pages: readonly number[]) => Promise<void>;
  // The browser's selection and the text lines it maps to, read when the model is off.
  readonly selection: Selection | null;
  readonly lookup: TextLineLookup;
  readonly store?: ToastStore;
}

function reportFailure(store: ToastStore, error: unknown): void {
  if (error instanceof RpcError) reportRpcError(store, error);
  else store.push('error', t('comment.failed'));
}

// The wire form of one page's share: each line's quad, as the engine's MarkupArea takes it.
function areaJson(area: PageArea) {
  return {
    page: area.page,
    text: area.text,
    quads: area.quads.map((quad) => ({
      ul: { x: quad.ul.x, y: quad.ul.y },
      ur: { x: quad.ur.x, y: quad.ur.y },
      ll: { x: quad.ll.x, y: quad.ll.y },
      lr: { x: quad.lr.x, y: quad.lr.y },
    })),
  };
}

// Marks the text selection with one kind of markup. No selected text gives `none`, so the ribbon
// can decide what that press means. A markup is one actions.run and one Undo step.
export async function markSelection(kind: MarkupKind, deps: MarkupDeps): Promise<MarkupOutcome> {
  const store = deps.store ?? toasts;
  if (deps.pageSpan() > MAX_TEXT_LAYERS) {
    store.push('info', t('markup.selectionTooLarge'));
    return 'busy';
  }
  let read = deps.model();
  if (read.state === 'loading') {
    await deps.loadPages(read.pages);
    read = deps.model();
    if (read.state === 'loading') {
      store.push('info', t('text.stillLoading'));
      return 'busy';
    }
  }
  const fromModel = read.state === 'ready';
  const areas =
    read.state === 'ready' ? read.value : domSelectionAreas(deps.selection, deps.lookup);
  if (areas.length === 0) return 'none';
  try {
    // The author is read at each markup, as a comment's is (W4.5 S3).
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.mark_text',
      args: { kind, areas: areas.map(areaJson), author: readPreferences().authorName },
    });
    if (!reply.executed) {
      store.push('error', t('comment.failed'));
      return 'unmarked';
    }
    deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
    if (fromModel) deps.clearModel();
    else deps.selection?.removeAllRanges();
    offerUndo('info', t('comment.added'), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      onUndone: (undone) => deps.scheduler.noteRevisions(undone.changed?.revisions ?? {}),
      store,
    });
    return 'marked';
  } catch (error) {
    reportFailure(store, error);
    return 'failed';
  }
}

// A markup button press. With text selected the markup is applied at once. With none, Highlight
// does what it did before (`noSelection` turns its drag tool on or off, for a box on a page with
// no text), and the other markups say that text must be selected first. Only `none` means there
// was no selection: every other outcome has already told the user what happened.
export async function pressMarkup(
  kind: MarkupKind,
  deps: MarkupDeps,
  noSelection: () => void,
): Promise<void> {
  const outcome = await markSelection(kind, deps);
  if (outcome !== 'none') return;
  if (kind === 'highlight') noSelection();
  else (deps.store ?? toasts).push('info', t('markup.selectTextFirst'));
}
