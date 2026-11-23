// Committing an Edit tool gesture (W6.7a S5): a move or a resize of the selected objects is one
// content.transform, a delete is one content.delete, each one actions.run and so one undo step on
// the engine. The web keeps no history of its own: the Undo toast undoes the engine's last step.
// The layer previews a gesture; this file is the only place that makes it. A typed paragraph is
// committed here too (W6.8a 8a-1): one content.replace_text, one undo step.
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import {
  reportRpcError,
  type ToastAction,
  type ToastKind,
  type ToastStore,
  toasts,
} from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { PageObjectDto, RectDto, RunResult } from '../rpc/generated';
import type { RenderScheduler } from '../view/renderScheduler';
import type { Affine } from './hitTest';
import { reselect } from './hitTest';
import type { ObjectCache } from './objectCache';
import { DEFAULT_TEXT_ARG, missingChars, type TextStyleArg } from './textStyle';

export { DEFAULT_TEXT_STYLE } from './textStyle';

// One committed gesture. Every object is on `page`, at `revision` (the revision its keys were
// listed at). `boxes` are where the objects are after a move or a resize, for the reselection.
export type EditChange =
  | {
      readonly kind: 'move' | 'resize';
      readonly page: number;
      readonly revision: number;
      readonly objects: readonly PageObjectDto[];
      readonly matrix: Affine;
      readonly boxes: readonly RectDto[];
    }
  | {
      readonly kind: 'delete';
      readonly page: number;
      readonly revision: number;
      readonly objects: readonly PageObjectDto[];
    }
  | {
      // One picture swapped for the file (W6.7b slice 2b). The engine keeps its box and stretches
      // the new picture to it. The file is read only when the change is sent.
      readonly kind: 'replace';
      readonly page: number;
      readonly revision: number;
      readonly objects: readonly PageObjectDto[];
      readonly file: Blob;
    };

// One typed paragraph: `object` is the text block as the list showed it at `revision`, and `text`
// is what the user typed. `style` is the style the bar changed (W6.8b slice 1), or null/absent when
// it did not: the engine then keeps the block's own style.
export interface TextChange {
  readonly page: number;
  readonly revision: number;
  readonly object: PageObjectDto;
  readonly text: string;
  readonly style?: TextStyleArg | null;
}

// What the editor should do after a commit: `done` closes it, `busy` keeps it open with its text
// (the engine was busy, and a retry is likely to work), `failed` closes it (the text is offered
// with Copy text, see copyAction).
export type TextOutcome = 'done' | 'busy' | 'failed';

// The selection an edit leaves: the keys of its page at the revision they were listed at.
export interface SettledSelection {
  readonly page: number;
  readonly revision: number;
  readonly keys: readonly string[];
}

export interface CommitDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly cache: ObjectCache;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
}

// The value a text commit returns for a font the engine had to substitute (W6.8a design 4.2).
export interface FontChoice {
  readonly name: string;
  readonly embedded_reused: boolean;
  readonly substituted: boolean;
  readonly missing: string;
}

const LABELS = {
  move: 'edit.moved',
  resize: 'edit.resized',
  delete: 'edit.deleted',
  replace: 'edit.image.replaced',
} as const;

// Asks the engine for the page's objects again after a stale reply and moves the scheduler to the
// revision it names, so the layer lists the page afresh. A failed ask is left to the next change.
export async function refreshStale(deps: CommitDeps, page: number): Promise<void> {
  deps.cache.clear();
  try {
    const fresh = await deps.rpc.call('content.objects', { handle: deps.handle, page });
    deps.scheduler.noteRevisions({ [String(page)]: fresh.revision });
  } catch {
    // Nothing to do: the next revision change or reopen lists the page again.
  }
}

// The reselection after a move, a resize or a typed paragraph: the objects now nearest to the
// given boxes. Null when the list cannot be read, in which case nothing is selected.
async function reselected(
  deps: CommitDeps,
  page: number,
  boxes: readonly RectDto[],
  revision: number,
): Promise<SettledSelection | null> {
  try {
    const list = await deps.cache.get(page, revision);
    if (list.revision !== revision) return null;
    return {
      page,
      revision,
      keys: reselect(list.objects, boxes),
    };
  } catch {
    return null;
  }
}

// Where the objects of a change are after it, for the reselection. A replace keeps the box it had.
function boxesOf(change: Exclude<EditChange, { kind: 'delete' }>): readonly RectDto[] {
  return change.kind === 'replace' ? change.objects.map((o) => o.bbox) : change.boxes;
}

// The one engine call a change makes. The file of a replace is read here, so an unreadable file
// fails like any other failed edit.
async function runChange(
  deps: CommitDeps,
  change: EditChange,
  refs: readonly { page: number; key: string; revision: number }[],
): Promise<RunResult> {
  if (change.kind === 'replace') {
    const [object] = refs;
    if (object === undefined) throw new Error('a replace names one picture');
    const data = await change.file.arrayBuffer();
    return deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.replace_image',
      args: { object, data },
    });
  }
  if (change.kind === 'delete') {
    return deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.delete',
      args: { objects: refs },
    });
  }
  return deps.rpc.call('actions.run', {
    handle: deps.handle,
    name: 'content.transform',
    args: {
      objects: refs,
      matrix: toMatrix(change.matrix),
      resize: change.kind === 'resize',
    },
  });
}

// Offers Undo for the step a reply made, and clears the selection when the step is undone: the
// engine's history moved back, so no list or selection of the old state is kept.
function offerEditUndo(
  deps: CommitDeps,
  kind: ToastKind,
  text: string,
  reply: RunResult,
  settle: (selection: SettledSelection | null) => void,
): void {
  offerUndo(kind, text, {
    rpc: deps.rpc,
    handle: deps.handle,
    history: reply.state.history,
    onUndone: (undone) => {
      deps.cache.clear();
      settle(null);
      deps.scheduler.noteRevisions(undone.changed?.revisions ?? {});
    },
    store: deps.store ?? toasts,
  });
}

// Runs the change through the engine, then notes the revisions, offers Undo, and tells the caller
// what to select. `settle` gets null when nothing should stay selected. A BUSY or a refusal keeps
// the selection and shows the usual message.
export async function commitEdit(
  deps: CommitDeps,
  change: EditChange,
  settle: (selection: SettledSelection | null) => void,
): Promise<void> {
  if (change.objects.length === 0) return;
  const store = deps.store ?? toasts;
  const refs = change.objects.map((o) => ({
    page: change.page,
    key: o.key,
    revision: change.revision,
  }));
  let reply: RunResult;
  try {
    reply = await runChange(deps, change, refs);
  } catch (error) {
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      settle(null);
      await refreshStale(deps, change.page);
      store.push('warning', t('edit.stale'));
    } else if (error instanceof RpcError) {
      reportRpcError(store, error);
    } else {
      store.push('error', t('edit.failed'));
    }
    return;
  }
  if (!reply.executed) return;

  const revisions = reply.changed?.revisions ?? {};
  deps.scheduler.noteRevisions(revisions);
  offerEditUndo(deps, 'info', t(LABELS[change.kind]), reply, settle);

  if (change.kind === 'delete') {
    settle(null);
    return;
  }
  const next = revisions[String(change.page)];
  settle(next === undefined ? null : await reselected(deps, change.page, boxesOf(change), next));
}

// Commits a typed paragraph (W6.8a 8a-1): one content.replace_text, and one undo step. The style is
// sent only when the bar changed it (`change.style`), else null, so the engine keeps the block's own.
// Errors are shown here, with Copy text where the typing could be lost, so the caller only has to
// close (or keep open on `busy`).
export async function commitText(
  deps: CommitDeps,
  change: TextChange,
  settle: (selection: SettledSelection | null) => void,
): Promise<TextOutcome> {
  const store = deps.store ?? toasts;
  const copy = copyAction(store, change.text);
  let reply: RunResult;
  try {
    reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.replace_text',
      args: {
        object: { page: change.page, key: change.object.key, revision: change.revision },
        text: change.text,
        style: change.style ?? null,
      },
    });
  } catch (error) {
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      settle(null);
      await refreshStale(deps, change.page);
      store.push('warning', t('edit.text.stale'), copy);
      return 'failed';
    }
    if (error instanceof RpcError && error.code === 'BUSY') {
      reportRpcError(store, error);
      return 'busy';
    }
    if (error instanceof RpcError) {
      reportRpcError(store, error, undefined, copy);
    } else {
      store.push('error', t('edit.text.failed'), copy);
    }
    return 'failed';
  }
  if (!reply.executed) return 'done';

  const revisions = reply.changed?.revisions ?? {};
  deps.scheduler.noteRevisions(revisions);
  const choice = fontChoiceOf(reply.value);
  const requested = change.style?.font ?? change.object.style?.font ?? '';
  const notice = choice !== null && choice.substituted ? substitutedText(choice, requested) : null;
  if (notice !== null) {
    offerEditUndo(deps, 'warning', notice, reply, settle);
  } else {
    offerEditUndo(deps, 'info', t('edit.textEdited'), reply, settle);
  }

  const next = revisions[String(change.page)];
  settle(
    next === undefined ? null : await reselected(deps, change.page, [change.object.bbox], next),
  );
  return 'done';
}

// One typed new block (W6.8a 8a-2): `rect` is the box the gesture gave, in visible page points.
export interface AddChange {
  readonly page: number;
  readonly rect: RectDto;
  readonly text: string;
  // The style the bar set (W6.8b slice 1); null or absent, the default style of a new block.
  readonly style?: TextStyleArg | null;
}

// The editor's stand-in for a block that does not exist yet: a text block at `rect`, with no key.
export function newTextBlock(rect: RectDto): PageObjectDto {
  return {
    type: 'text',
    key: '',
    bbox: rect,
    text: '',
    style: DEFAULT_TEXT_ARG,
    editable: true,
    reason: '',
    image_size: [0, 0],
    stroke: false,
    fill: false,
  };
}

// Adds a typed block (W6.8a 8a-2): one content.add_text, so one engine Command and one undo step.
// A blank text is not sent (the editor closes, as the desktop's does). The errors are shown as for
// commitText, and the reply says whether the editor closes (`busy` keeps it open with its text).
export async function commitAdd(deps: CommitDeps, change: AddChange): Promise<TextOutcome> {
  if (change.text.trim() === '') return 'done';
  const store = deps.store ?? toasts;
  const copy = copyAction(store, change.text);
  let reply: RunResult;
  try {
    reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.add_text',
      args: {
        page: change.page,
        rect: change.rect,
        text: change.text,
        style: change.style ?? DEFAULT_TEXT_ARG,
      },
    });
  } catch (error) {
    if (error instanceof RpcError && error.code === 'BUSY') {
      reportRpcError(store, error);
      return 'busy';
    }
    if (error instanceof RpcError) {
      reportRpcError(store, error, undefined, copy);
    } else {
      store.push('error', t('edit.text.failed'), copy);
    }
    return 'failed';
  }
  if (!reply.executed) return 'done';
  deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
  // The new block has no selection to keep: the tool returns to Select, so the step is only offered.
  offerEditUndo(deps, 'info', t('edit.textAdded'), reply, () => undefined);
  return 'done';
}

// The typing of an editor that was dropped unapplied (its page scrolled out of the mounted range,
// or its tab closed): one info toast with Copy text, so the words are not lost. Nothing is sent to
// the engine.
export function offerDroppedText(text: string, store: ToastStore = toasts): void {
  store.push('info', t('edit.text.dropped'), copyAction(store, text));
}

// The reply's value when it is a FontChoice, else null. RunParams.args and RunResult.value are
// untyped in generated.ts, so the shape is checked here.
export function fontChoiceOf(value: unknown): FontChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<FontChoice>;
  if (typeof v.name !== 'string' || typeof v.substituted !== 'boolean') return null;
  if (typeof v.missing !== 'string') return null;
  return v as FontChoice;
}

// The warning for a substituted font (W6.8b design section 5.1), or null when there is nothing to
// say. Three cases: the font the text used lacks characters (the engine kept it, so the text may not
// show them); the font could not be reused and another was used, with the missing characters when
// the engine knows them.
function substitutedText(choice: FontChoice, requested: string): string | null {
  if (choice.name === requested) {
    if (choice.missing === '') return null;
    return t('edit.font.missingGlyphs', { font: choice.name, chars: showChars(choice.missing) });
  }
  if (choice.missing === '')
    return t('edit.font.notReused', { font: requested, used: choice.name });
  const base = t('edit.text.substituted', { name: choice.name });
  return `${base} ${t('edit.text.missing', { chars: showChars(choice.missing) })}`;
}

// The missing characters as a person reads them: at most 20, then "and N more".
function showChars(chars: string): string {
  const { shown, more } = missingChars(chars);
  return more > 0 ? `${shown} ${t('edit.font.moreChars', { count: more })}` : shown;
}

// The recovery for a failed commit: the typed text goes to the clipboard, so nothing is lost.
function copyAction(store: ToastStore, text: string): ToastAction {
  return {
    label: t('edit.text.copy'),
    run: () => {
      void copyToClipboard(store, text);
    },
  };
}

async function copyToClipboard(store: ToastStore, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    store.push('success', t('edit.text.copied'));
  } catch {
    store.push('error', t('edit.text.failed'));
  }
}

// The six numbers of the matrix as the engine's Matrix dataclass names them.
function toMatrix(m: Affine): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const [a, b, c, d, e, f] = m;
  return { a, b, c, d, e, f };
}
