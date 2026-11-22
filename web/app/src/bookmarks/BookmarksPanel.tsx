// The bookmarks side panel (W5.2, W1.4 section 9): the document outline as a tree (ARIA tree roles,
// with the arrow keys of the tree pattern). A click on an entry, or Enter on it, asks the document
// view to scroll to its place. Where the engine has outline_write, the panel also adds, renames,
// deletes, moves and re-targets entries, by keys (Alt+Shift+N, F2, Delete, Alt+Shift+Arrow) or a
// toolbar of text buttons. Each edit is one engine action with an Undo toast; the outline then
// reloads. A new entry's title opens for typing (S3), so it can be named at once.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t, tp } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { HistoryResult, OutlineEntry } from '../rpc/generated';
import type { ViewPlace } from '../view/layout';
import { expandedOf, fingerprintOf, setExpandedOf } from './expansion';
import type { Resolved } from './drop';
import { runBookmarkEdit, type BookmarkEditOutcome } from './runEdit';
import {
  applyAdd,
  applyDelete,
  applyMove,
  childrenOf,
  defaultTitle,
  deleteFocus,
  MAX_OUTLINE_DEPTH,
  moveTarget,
  parentOf,
  remapExpanded,
  subtreeEnd,
  type MoveDirection,
  type MoveTarget,
} from './outlineEdit';
import { initialExpanded, treeAction, visibleRows, type BookmarkAction } from './tree';
import { useOutlineDrag } from './useOutlineDrag';
import './bookmarks.css';

export interface BookmarksPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // The tab the panel belongs to: its expansion state is kept per tab.
  readonly tabId: number;
  // The page shown in the view (zero-based): the place a bookmark goes to when the view has none.
  readonly currentPage: number;
  // Changes when the structure or the outline changed (App's structureRevision): the outline reloads.
  readonly revision: number;
  // Reports the step an Undo toast undid or redid, so the app can refresh what it shows.
  readonly onHistoryStep: (reply: HistoryResult) => void;
  // Called with the page index (zero-based) and the top (points from the page top, null for the top)
  // when an entry with a page is chosen.
  readonly onSelect: (index: number, top: number | null) => void;
  // The place a new or re-targeted bookmark goes to. A function read at the moment of the edit, so
  // scrolling does not re-render the panel.
  readonly location: () => ViewPlace | null;
  // The document's page labels: a new bookmark's default title uses the label of its page.
  readonly labels: readonly string[];
  // The first line of the model's text selection, or null when there is none.
  readonly selectedText: () => string | null;
  readonly onClose: () => void;
}

// The deepest indent the stylesheet has a rule for; deeper entries share its indent.
const MAX_DEPTH = 8;

// The key of each edit, as the toolbar's tooltip and aria-keyshortcuts show it.
const KEYS = {
  add: 'Alt+Shift+N',
  rename: 'F2',
  delete: 'Delete',
  up: 'Alt+Shift+ArrowUp',
  down: 'Alt+Shift+ArrowDown',
  in: 'Alt+Shift+ArrowRight',
  out: 'Alt+Shift+ArrowLeft',
} as const;

type EditKind =
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'delete' }
  | { readonly kind: 'move'; readonly direction: MoveDirection }
  // A drag's drop (W5.2 drag and drop): the same move, to a target the drag worked out.
  | { readonly kind: 'moveTo'; readonly target: MoveTarget }
  | { readonly kind: 'page'; readonly place: ViewPlace };

// A toolbar button's click: an add (after the row, or as its child), opening the rename field, the
// page edit (which reads the view's place at the click), or an edit that is sent as it is.
type ToolbarAction =
  | { readonly kind: 'add'; readonly asChild: boolean }
  | { readonly kind: 'rename' }
  | { readonly kind: 'page' }
  | { readonly kind: 'edit'; readonly edit: EditKind };

// One edit as the panel will send it, with the outline it predicts for the reload.
interface PlannedEdit {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly text: string;
  readonly next: readonly OutlineEntry[];
  readonly nextExpanded: ReadonlySet<number>;
  // The flat index of the row to focus after the reload (in the predicted outline), or null.
  readonly focus: number | null;
  // An added bookmark: after the reload its title field opens, instead of focusing the row.
  readonly rename?: boolean;
}

// Works out the engine call for one edit of the row at `index`, or null when there is nothing to
// send (an empty or unchanged title, or a move with no target). Pure, so the arithmetic lives in
// outlineEdit.ts; this only shapes the arguments and the message.
function planEdit(
  entries: readonly OutlineEntry[],
  expanded: ReadonlySet<number>,
  index: number,
  edit: EditKind,
): PlannedEdit | null {
  const entry = entries[index];
  if (entry === undefined) return null;
  const expect_title = entry.title;
  switch (edit.kind) {
    case 'rename': {
      const title = edit.title.trim();
      if (title === '' || title === entry.title) return null;
      return {
        name: 'outline.rename',
        args: { index, expect_title, title },
        text: t('bookmarks.renamed'),
        next: entries.map((e, k) => (k === index ? { ...e, title } : e)),
        nextExpanded: expanded,
        focus: index,
      };
    }
    case 'page': {
      const { page, top } = edit.place;
      return {
        name: 'outline.set_destination',
        args: { index, expect_title, page, y: top },
        text: t('bookmarks.destinationSet', { page: page + 1 }),
        next: entries.map((e, k) => (k === index ? { ...e, page, top } : e)),
        nextExpanded: expanded,
        focus: index,
      };
    }
    case 'delete': {
      const nested = subtreeEnd(entries, index) - index - 1;
      const removed = applyDelete(entries, index);
      const text =
        nested > 0
          ? tp('bookmarks.deleted', nested, { title: entry.title })
          : t('bookmarks.deletedOne', { title: entry.title });
      return {
        name: 'outline.delete',
        args: { index, expect_title },
        text,
        next: removed.entries,
        nextExpanded: remapExpanded(expanded, removed.order),
        focus: deleteFocus(entries, index),
      };
    }
    case 'move': {
      const target = moveTarget(entries, index, edit.direction);
      return target === null ? null : planMoveTo(entries, expanded, index, target);
    }
    case 'moveTo':
      return planMoveTo(entries, expanded, index, edit.target);
  }
}

// The engine call that moves entry `index` to `target` (S2's move, and a drag's drop).
function planMoveTo(
  entries: readonly OutlineEntry[],
  expanded: ReadonlySet<number>,
  index: number,
  target: MoveTarget,
): PlannedEdit {
  const expect_title = entries[index]?.title ?? '';
  const plan = applyMove(entries, index, target.parent, target.position);
  const siblings = childrenOf(plan.entries, parentOf(plan.entries, plan.moved));
  const nextExpanded = remapExpanded(expanded, plan.order);
  // The entry's new parent opens, so the moved entry stays visible.
  const parent = parentOf(plan.entries, plan.moved);
  if (parent !== null) nextExpanded.add(parent);
  return {
    name: 'outline.move',
    args: { index, expect_title, parent: target.parent, position: target.position },
    text: t('bookmarks.moved', {
      title: expect_title,
      level: plan.entries[plan.moved]?.level ?? 1,
      position: siblings.indexOf(plan.moved) + 1,
      count: siblings.length,
    }),
    next: plan.entries,
    nextExpanded,
    focus: plan.moved,
  };
}

// What a drag's release would do, as the live region says it (W5.2 drag and drop). Empty when no
// drag points anywhere.
function dropMessage(entries: readonly OutlineEntry[], resolved: Resolved | null): string {
  if (resolved === null) return '';
  const { result, label, level } = resolved;
  if (result.kind === 'same') return t('bookmarks.drop.same');
  if (result.kind === 'own') return t('bookmarks.drop.own');
  if (result.kind === 'deep') return t('error.REFUSED.outlineTooDeep');
  const title = label.ref === null ? '' : (entries[label.ref]?.title ?? '');
  switch (label.message) {
    case 'inside':
      return t('bookmarks.drop.inside', { title });
    case 'first':
      return t('bookmarks.drop.first', { title });
    case 'after':
      return t('bookmarks.drop.after', { title, level });
    case 'top':
      return t('bookmarks.drop.top');
  }
}

// The engine call for a new bookmark after `after` (null: the end of the top level), at `place`,
// with `title`. The predicted outline is applyAdd's, which follows the engine's placement.
function planAdd(
  entries: readonly OutlineEntry[],
  expanded: ReadonlySet<number>,
  after: number | null,
  asChild: boolean,
  place: ViewPlace,
  title: string,
): PlannedEdit | null {
  const anchor = after === null ? undefined : entries[after];
  if (after !== null && anchor === undefined) return null;
  const predicted = applyAdd(entries, after, asChild, { title, page: place.page, top: place.top });
  const nextExpanded = remapExpanded(expanded, predicted.order);
  // A child opens its parent, so the new row is visible.
  if (asChild && after !== null) nextExpanded.add(after);
  return {
    name: 'outline.add',
    args: {
      title,
      page: place.page,
      y: place.top,
      after,
      as_child: asChild,
      // The title the panel shows at `after`: a stale panel is refused instead of adding in the wrong place.
      expect_after: anchor?.title ?? null,
    },
    text: t('bookmarks.added', { title, page: place.page + 1 }),
    next: predicted.entries,
    nextExpanded,
    focus: predicted.added,
    rename: true,
  };
}

// The title field of the row being renamed. Enter and Escape end it and return the focus to the
// row; a blur ends it without moving the focus, so a click elsewhere is not pulled back.
function RenameField({
  title,
  onDone,
}: {
  readonly title: string;
  readonly onDone: (value: string | null, refocus: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  // Unmounting (the outline was replaced under the field) ends it without an edit. Runs before the
  // input leaves the DOM, so a blur from the removal cannot send a rename for a row that is gone.
  useLayoutEffect(
    () => () => {
      settled.current = true;
    },
    [],
  );
  const finish = (value: string | null, refocus: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onDone(value, refocus);
  };
  return (
    <input
      ref={ref}
      type="text"
      className="bookmarks-rename"
      maxLength={1000}
      defaultValue={title}
      aria-label={t('bookmarks.rename.label')}
      onKeyDown={(event) => {
        // Keys typed in the field are not tree keys, and the Edit tool's Delete must not see them.
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null, true);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value, false)}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function BookmarkTree({
  rpc,
  handle,
  tabId,
  currentPage,
  revision,
  onHistoryStep,
  onSelect,
  location,
  labels,
  selectedText,
}: Omit<BookmarksPanelProps, 'onClose'>) {
  const [entries, setEntries] = useState<readonly OutlineEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  // The current row (roving tab stop, aria-selected): the focused row, or null until the user
  // reaches the tree.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [editable, setEditable] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Set when Escape cancels a drag, so the live region says so once; cleared by the next drag.
  const [cancelNote, setCancelNote] = useState(false);
  const hintId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Set by an edit: the row to focus once the reloaded outline has rendered (null index: none).
  // `rename` opens that row's title field instead (a new bookmark).
  const pendingFocus = useRef<{ index: number | null; rename?: boolean } | null>(null);
  // A synchronous guard: a second key or click before the state updates must not send a second edit.
  const busyRef = useRef(false);
  // Set by an edit that changed the outline: busy then lasts until the reload has applied the new
  // entries, so a key pressed in between cannot plan against the outline the edit replaced.
  const reloadPending = useRef(false);

  useEffect(() => {
    let active = true;
    // Ends the edit's busy state once its reload has settled (applied or failed).
    const releaseEdit = () => {
      if (!reloadPending.current) return;
      reloadPending.current = false;
      busyRef.current = false;
      setBusy(false);
    };
    // A failed capability read counts as read-only: the toolbar and the edit keys stay off.
    const writable = rpc.call('session.capabilities', { handle }).then(
      (reply) => reply.engine.outline_write === true,
      () => false,
    );
    Promise.all([rpc.call('session.outline', { handle }), writable])
      .then(([reply, canWrite]) => {
        if (!active) return;
        // A load of an outline the tab has seen keeps the user's choices; otherwise the file's own
        // flags apply.
        const key = fingerprintOf(reply.entries);
        setExpanded(expandedOf(tabId, key) ?? initialExpanded(reply.entries));
        setEditable(canWrite);
        setEntries(reply.entries);
        // A rename field open on the replaced outline would point at a stale row: close it.
        setEditing(null);
        releaseEdit();
      })
      .catch(() => {
        if (!active) return;
        setLoadFailed(true);
        releaseEdit();
      });
    return () => {
      active = false;
    };
  }, [rpc, handle, tabId, revision, reloadToken]);

  // After an edit's reload the focus moves to the target row, unless the user has moved it out of
  // the panel. A toolbar button that still works keeps the focus, so Move Down can be repeated.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || entries === null) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    const inPanel =
      listRef.current?.contains(active) === true || toolbarRef.current?.contains(active) === true;
    if (active !== null && active !== document.body && !inPanel) return;
    if (pending.index === null) return;
    const index = Math.min(pending.index, entries.length - 1);
    setFocusIndex(index);
    // A new bookmark's title field focuses itself when it opens.
    if (pending.rename === true) {
      setEditing(index);
      return;
    }
    if (
      active instanceof HTMLButtonElement &&
      toolbarRef.current?.contains(active) === true &&
      !active.disabled
    ) {
      return;
    }
    const row =
      listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) ??
      listRef.current?.querySelector<HTMLElement>('[data-index]');
    row?.focus();
  }, [entries]);

  // Sends one edit, then saves the expansion the reload should show and asks for the reload.
  const runEdit = async (plan: PlannedEdit | null) => {
    if (plan === null || entries === null || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // Saved before the edit, so an Undo finds the expansion this outline had.
    setExpandedOf(tabId, fingerprintOf(entries), new Set(expanded));
    let outcome: BookmarkEditOutcome = 'failed';
    let value: unknown;
    try {
      const result = await runBookmarkEdit(
        { rpc, handle, onHistoryStep },
        plan.name,
        plan.args,
        plan.text,
      );
      outcome = result.outcome;
      value = result.value;
    } finally {
      // A reload follows an edit that went through or found the outline stale; the reload effect
      // ends the busy state once it has applied the entries.
      if (outcome !== 'done' && outcome !== 'stale') {
        busyRef.current = false;
        setBusy(false);
      }
    }
    if (outcome === 'done') {
      setExpandedOf(tabId, fingerprintOf(plan.next), new Set(plan.nextExpanded));
      // An added bookmark focuses the index the engine returned; the predicted one is the fallback.
      const focus = plan.rename === true && typeof value === 'number' ? value : plan.focus;
      pendingFocus.current = { index: focus, rename: plan.rename };
      reloadPending.current = true;
      setReloadToken((count) => count + 1);
    } else if (outcome === 'stale') {
      pendingFocus.current = { index: focusIndex ?? 0 };
      reloadPending.current = true;
      setReloadToken((count) => count + 1);
    }
  };

  // Adds a bookmark after `after` (null: the end of the top level). It goes to the view's place,
  // and its title is the selected text, else "Page N" (S3).
  const addAt = (after: number | null, asChild: boolean) => {
    if (entries === null) return;
    const place = location() ?? { page: currentPage, top: null };
    const label = labels[place.page] ?? null;
    const title = defaultTitle(selectedText(), label, place.page + 1);
    void runEdit(planAdd(entries, expanded, after, asChild, place, title));
  };

  const toggle = (index: number) => {
    if (entries === null) return;
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
    setExpandedOf(tabId, fingerprintOf(entries), next);
  };
  // The visible rows, and the drag (hooks run before the early returns below, so they run every render).
  const rows = entries === null ? [] : visibleRows(entries, expanded);
  const outlineDrag = useOutlineDrag({
    listRef,
    entries,
    rows,
    enabled: editable && !busy && editing === null,
    busy,
    revision,
    onStart: (index) => {
      setCancelNote(false);
      setFocusIndex(index);
    },
    onDrop: (index, target) => {
      if (entries !== null)
        void runEdit(planEdit(entries, expanded, index, { kind: 'moveTo', target }));
    },
    onCancel: () => setCancelNote(true),
    // Only a closed entry is opened, so this never collapses one.
    onSpringLoad: (index) => {
      if (!expanded.has(index)) toggle(index);
    },
  });

  if (loadFailed) {
    return (
      <p role="alert" className="bookmarks-status">
        {t('bookmarks.loadFailed')}
      </p>
    );
  }
  if (entries === null) {
    return (
      <p role="status" className="bookmarks-status">
        {t('bookmarks.loading')}
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <>
        <p role="status" className="bookmarks-status">
          {t('bookmarks.empty')}
        </p>
        {editable ? (
          <div className="bookmarks-status-action">
            <button
              type="button"
              className="bookmarks-action"
              disabled={busy}
              onClick={() => addAt(null, false)}
            >
              {t('bookmarks.addFirst')}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  // The focus stays on a visible row; when the focused row is hidden, the first row takes it.
  const activeIndex = rows.some((row) => row.index === focusIndex) ? focusIndex : rows[0]?.index;
  const locked = busy || editing !== null;

  const focusRow = (index: number) => {
    setFocusIndex(index);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };
  const choose = (index: number) => {
    const row = entries[index];
    const page = row?.page;
    if (row !== undefined && page !== null && page !== undefined) onSelect(page, row.top);
  };

  const canEdit = editable && !locked;
  const finishRename = (index: number, value: string | null, refocus: boolean) => {
    setEditing(null);
    if (refocus) focusRow(index);
    if (value !== null)
      void runEdit(planEdit(entries, expanded, index, { kind: 'rename', title: value }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const action: BookmarkAction = treeAction(rows, event.key, index, {
      alt: event.altKey,
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      code: event.code,
    });
    if (action.kind === 'none') return;
    // Every key the panel handles is prevented, even an edit key that does nothing here: the Edit
    // tool's document-level Delete listener must not act on a Delete the panel has taken.
    event.preventDefault();
    if (
      action.kind === 'add' ||
      action.kind === 'rename' ||
      action.kind === 'delete' ||
      action.kind === 'move'
    ) {
      // Edit keys do nothing while an edit runs or when the document cannot be edited; the
      // navigation keys still work.
      if (!canEdit) return;
    }
    if (action.kind === 'focus') focusRow(action.index);
    else if (action.kind === 'expand' || action.kind === 'collapse') toggle(action.index);
    else if (action.kind === 'activate') choose(action.index);
    else if (action.kind === 'add') addAt(action.index, false);
    else if (action.kind === 'rename') setEditing(action.index);
    else if (action.kind === 'delete') {
      void runEdit(planEdit(entries, expanded, action.index, { kind: 'delete' }));
    } else if (action.kind === 'move') {
      void runEdit(
        planEdit(entries, expanded, action.index, { kind: 'move', direction: action.direction }),
      );
    }
  };

  const current = activeIndex ?? null;
  // The toolbar's buttons, each acting on the current row: `action` says what a click does (see
  // runToolbar); `hint` is the tooltip of a button that is off for a reason the user can act on.
  const toolbarButtons: {
    readonly id: string;
    readonly label: string;
    readonly keys: string;
    readonly disabled: boolean;
    readonly hint?: string;
    readonly action: ToolbarAction;
  }[] = [];
  if (current !== null) {
    const edgeOf = (direction: MoveDirection) => moveTarget(entries, current, direction) === null;
    const level = entries[current]?.level ?? 1;
    toolbarButtons.push(
      {
        id: 'add',
        label: t('bookmarks.add'),
        keys: KEYS.add,
        disabled: false,
        action: { kind: 'add', asChild: false },
      },
      {
        id: 'addChild',
        label: t('bookmarks.addChild'),
        keys: '',
        disabled: level >= MAX_OUTLINE_DEPTH,
        hint: t('bookmarks.addChild.tooDeep'),
        action: { kind: 'add', asChild: true },
      },
      {
        id: 'rename',
        label: t('bookmarks.rename'),
        keys: KEYS.rename,
        disabled: false,
        action: { kind: 'rename' },
      },
      {
        id: 'delete',
        label: t('bookmarks.delete'),
        keys: KEYS.delete,
        disabled: false,
        action: { kind: 'edit', edit: { kind: 'delete' } },
      },
      {
        id: 'up',
        label: t('bookmarks.moveUp'),
        keys: KEYS.up,
        disabled: edgeOf('up'),
        action: { kind: 'edit', edit: { kind: 'move', direction: 'up' } },
      },
      {
        id: 'down',
        label: t('bookmarks.moveDown'),
        keys: KEYS.down,
        disabled: edgeOf('down'),
        action: { kind: 'edit', edit: { kind: 'move', direction: 'down' } },
      },
      {
        id: 'in',
        label: t('bookmarks.indent'),
        keys: KEYS.in,
        disabled: edgeOf('in'),
        action: { kind: 'edit', edit: { kind: 'move', direction: 'in' } },
      },
      {
        id: 'out',
        label: t('bookmarks.outdent'),
        keys: KEYS.out,
        disabled: edgeOf('out'),
        action: { kind: 'edit', edit: { kind: 'move', direction: 'out' } },
      },
      {
        id: 'page',
        label: t('bookmarks.setDestination'),
        keys: '',
        disabled: false,
        action: { kind: 'page' },
      },
    );
  }
  // What a toolbar click does, read when the click happens (the view's place is read then too).
  const runToolbar = (action: ToolbarAction, index: number) => {
    if (action.kind === 'add') addAt(index, action.asChild);
    else if (action.kind === 'rename') setEditing(index);
    else if (action.kind === 'page') {
      const place = location() ?? { page: currentPage, top: null };
      void runEdit(planEdit(entries, expanded, index, { kind: 'page', place }));
    } else void runEdit(planEdit(entries, expanded, index, action.edit));
  };

  return (
    <>
      {editable ? (
        <div
          ref={toolbarRef}
          role="toolbar"
          className="bookmarks-toolbar"
          aria-label={t('bookmarks.actions')}
        >
          {toolbarButtons.map((button) => (
            <button
              key={button.id}
              type="button"
              className="bookmarks-action"
              disabled={button.disabled}
              aria-disabled={locked || undefined}
              aria-keyshortcuts={button.keys || undefined}
              title={
                button.disabled && button.hint !== undefined
                  ? button.hint
                  : button.keys
                    ? `${button.label} (${button.keys})`
                    : button.label
              }
              onClick={() => {
                if (!canEdit || current === null) return;
                runToolbar(button.action, current);
              }}
            >
              {button.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        ref={listRef}
        role="tree"
        className="bookmarks-list panel-fill"
        aria-label={t('bookmarks.list')}
        aria-busy={busy || undefined}
        aria-describedby={editable ? hintId : undefined}
        data-drag={
          outlineDrag.drag === null
            ? undefined
            : outlineDrag.drag.resolved?.result.kind === 'own' ||
                outlineDrag.drag.resolved?.result.kind === 'deep'
              ? 'refused'
              : 'active'
        }
        {...outlineDrag.handlers}
      >
        {rows.map((row, position) => {
          const isCurrent = row.index === activeIndex;
          // The dragged entry and its subtree are dimmed; the mark is the line or highlight of the drop.
          const dragging = outlineDrag.drag;
          const dragged =
            dragging !== null &&
            row.index >= dragging.index &&
            row.index < subtreeEnd(entries, dragging.index);
          const mark = dragging?.resolved?.result.kind === 'move' ? dragging.resolved.mark : null;
          const marked = mark !== null && mark.row === position;
          return (
            <div
              key={row.index}
              role="treeitem"
              className={isCurrent ? 'bookmarks-row bookmarks-row--current' : 'bookmarks-row'}
              data-index={row.index}
              data-depth={Math.min(row.entry.level, MAX_DEPTH)}
              data-dragged={dragged ? 'true' : undefined}
              data-drop={marked ? mark.edge : undefined}
              data-drop-depth={marked ? Math.min(mark.depth, MAX_DEPTH) : undefined}
              aria-level={row.entry.level}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              aria-disabled={row.entry.page === null ? true : undefined}
              aria-selected={isCurrent}
              tabIndex={isCurrent ? 0 : -1}
              onFocus={() => setFocusIndex(row.index)}
              onKeyDown={(event) => onKeyDown(event, row.index)}
              onClick={() => {
                setFocusIndex(row.index);
                choose(row.index);
              }}
            >
              {row.hasChildren ? (
                <span
                  className="bookmarks-toggle"
                  aria-hidden="true"
                  onClick={(event) => {
                    // The disclosure is a pointer shortcut; the arrow keys do the same on the row.
                    event.stopPropagation();
                    toggle(row.index);
                  }}
                >
                  <svg viewBox="0 0 12 12" focusable="false">
                    <path d={row.expanded ? 'M2 4l4 4 4-4' : 'M4 2l4 4-4 4'} />
                  </svg>
                </span>
              ) : (
                <span className="bookmarks-spacer" aria-hidden="true" />
              )}
              {editing === row.index ? (
                <RenameField
                  title={row.entry.title}
                  onDone={(value, refocus) => finishRename(row.index, value, refocus)}
                />
              ) : (
                <span className="bookmarks-title">{row.entry.title}</span>
              )}
            </div>
          );
        })}
      </div>
      {editable ? (
        <p id={hintId} className="visually-hidden">
          {t('bookmarks.drag.hint')}
        </p>
      ) : null}
      <div className="visually-hidden" aria-live="polite">
        {outlineDrag.drag !== null
          ? dropMessage(entries, outlineDrag.drag.resolved)
          : cancelNote
            ? t('bookmarks.drop.cancelled')
            : ''}
      </div>
    </>
  );
}

export function BookmarksPanel({ onClose, ...tree }: BookmarksPanelProps) {
  return (
    <Panel title={t('bookmarks.title')} onClose={onClose}>
      <BookmarkTree {...tree} />
    </Panel>
  );
}
