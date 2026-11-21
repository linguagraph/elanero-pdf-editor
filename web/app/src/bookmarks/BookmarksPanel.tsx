// The bookmarks side panel (W5.2, W1.4 section 9): the document outline as a tree (ARIA tree roles,
// with the arrow keys of the tree pattern). A click on an entry, or Enter on it, asks the document
// view to scroll to its page. Where the engine has outline_write (S2), the panel also renames,
// deletes, moves and re-targets entries, by keys (F2, Delete, Alt+Shift+Arrow) or a toolbar of text
// buttons. Each edit is one engine action with an Undo toast; the outline then reloads.
// Adding bookmarks comes later (S3).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t, tp } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { HistoryResult, OutlineEntry } from '../rpc/generated';
import { expandedOf, fingerprintOf, setExpandedOf } from './expansion';
import { runBookmarkEdit, type BookmarkEditOutcome } from './runEdit';
import {
  applyDelete,
  applyMove,
  childrenOf,
  deleteFocus,
  moveTarget,
  parentOf,
  remapExpanded,
  subtreeEnd,
  type MoveDirection,
} from './outlineEdit';
import { initialExpanded, treeAction, visibleRows, type BookmarkAction } from './tree';
import './bookmarks.css';

export interface BookmarksPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // The tab the panel belongs to: its expansion state is kept per tab.
  readonly tabId: number;
  // The page shown in the view (zero-based): Set to Current Page uses it.
  readonly currentPage: number;
  // Changes when the structure or the outline changed (App's structureRevision): the outline reloads.
  readonly revision: number;
  // Reports the step an Undo toast undid or redid, so the app can refresh what it shows.
  readonly onHistoryStep: (reply: HistoryResult) => void;
  // Called with the page index (zero-based) when an entry with a page is chosen.
  readonly onSelect: (index: number) => void;
  readonly onClose: () => void;
}

// The deepest indent the stylesheet has a rule for; deeper entries share its indent.
const MAX_DEPTH = 8;

// The key of each edit, as the toolbar's tooltip and aria-keyshortcuts show it.
const KEYS = {
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
  | { readonly kind: 'page'; readonly page: number };

// One edit as the panel will send it, with the outline it predicts for the reload.
interface PlannedEdit {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly text: string;
  readonly next: readonly OutlineEntry[];
  readonly nextExpanded: ReadonlySet<number>;
  // The flat index of the row to focus after the reload (in the predicted outline), or null.
  readonly focus: number | null;
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
    case 'page':
      return {
        name: 'outline.set_destination',
        args: { index, expect_title, page: edit.page, y: null },
        text: t('bookmarks.destinationSet', { page: edit.page + 1 }),
        next: entries.map((e, k) => (k === index ? { ...e, page: edit.page } : e)),
        nextExpanded: expanded,
        focus: index,
      };
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
      if (target === null) return null;
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
          title: entry.title,
          level: plan.entries[plan.moved]?.level ?? 1,
          position: siblings.indexOf(plan.moved) + 1,
          count: siblings.length,
        }),
        next: plan.entries,
        nextExpanded,
        focus: plan.moved,
      };
    }
  }
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
  const listRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Set by an edit: the row to focus once the reloaded outline has rendered (null index: none).
  const pendingFocus = useRef<{ index: number | null } | null>(null);
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
      <p role="status" className="bookmarks-status">
        {t('bookmarks.empty')}
      </p>
    );
  }

  const rows = visibleRows(entries, expanded);
  // The focus stays on a visible row; when the focused row is hidden, the first row takes it.
  const activeIndex = rows.some((row) => row.index === focusIndex) ? focusIndex : rows[0]?.index;
  const locked = busy || editing !== null;

  const toggle = (index: number) => {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
    setExpandedOf(tabId, fingerprintOf(entries), next);
  };
  const focusRow = (index: number) => {
    setFocusIndex(index);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };
  const choose = (index: number) => {
    const page = entries[index]?.page;
    if (page !== null && page !== undefined) onSelect(page);
  };

  // Sends one edit, then saves the expansion the reload should show and asks for the reload.
  const runEdit = async (plan: PlannedEdit | null) => {
    if (plan === null || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // Saved before the edit, so an Undo finds the expansion this outline had.
    setExpandedOf(tabId, fingerprintOf(entries), new Set(expanded));
    let outcome: BookmarkEditOutcome = 'failed';
    try {
      outcome = await runBookmarkEdit(
        { rpc, handle, onHistoryStep },
        plan.name,
        plan.args,
        plan.text,
      );
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
      pendingFocus.current = { index: plan.focus };
      reloadPending.current = true;
      setReloadToken((value) => value + 1);
    } else if (outcome === 'stale') {
      pendingFocus.current = { index: activeIndex ?? 0 };
      reloadPending.current = true;
      setReloadToken((value) => value + 1);
    }
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
    });
    if (action.kind === 'none') return;
    // Every key the panel handles is prevented, even an edit key that does nothing here: the Edit
    // tool's document-level Delete listener must not act on a Delete the panel has taken.
    event.preventDefault();
    if (action.kind === 'rename' || action.kind === 'delete' || action.kind === 'move') {
      // Edit keys do nothing while an edit runs or when the document cannot be edited; the
      // navigation keys still work.
      if (!canEdit) return;
    }
    if (action.kind === 'focus') focusRow(action.index);
    else if (action.kind === 'expand' || action.kind === 'collapse') toggle(action.index);
    else if (action.kind === 'activate') choose(action.index);
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
  // The toolbar's buttons, each acting on the current row: `edit` is what a click does ('rename'
  // opens the field, anything else is sent as an edit).
  const toolbarButtons: {
    readonly id: string;
    readonly label: string;
    readonly keys: string;
    readonly disabled: boolean;
    readonly edit: EditKind | 'rename';
  }[] = [];
  if (current !== null) {
    const edgeOf = (direction: MoveDirection) => moveTarget(entries, current, direction) === null;
    toolbarButtons.push(
      {
        id: 'rename',
        label: t('bookmarks.rename'),
        keys: KEYS.rename,
        disabled: false,
        edit: 'rename',
      },
      {
        id: 'delete',
        label: t('bookmarks.delete'),
        keys: KEYS.delete,
        disabled: false,
        edit: { kind: 'delete' },
      },
      {
        id: 'up',
        label: t('bookmarks.moveUp'),
        keys: KEYS.up,
        disabled: edgeOf('up'),
        edit: { kind: 'move', direction: 'up' },
      },
      {
        id: 'down',
        label: t('bookmarks.moveDown'),
        keys: KEYS.down,
        disabled: edgeOf('down'),
        edit: { kind: 'move', direction: 'down' },
      },
      {
        id: 'in',
        label: t('bookmarks.indent'),
        keys: KEYS.in,
        disabled: edgeOf('in'),
        edit: { kind: 'move', direction: 'in' },
      },
      {
        id: 'out',
        label: t('bookmarks.outdent'),
        keys: KEYS.out,
        disabled: edgeOf('out'),
        edit: { kind: 'move', direction: 'out' },
      },
      {
        id: 'page',
        label: t('bookmarks.setDestination'),
        keys: '',
        disabled: false,
        edit: { kind: 'page', page: currentPage },
      },
    );
  }

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
              title={button.keys ? `${button.label} (${button.keys})` : button.label}
              onClick={() => {
                if (current === null || !canEdit) return;
                if (button.edit === 'rename') setEditing(current);
                else void runEdit(planEdit(entries, expanded, current, button.edit));
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
      >
        {rows.map((row) => {
          const isCurrent = row.index === activeIndex;
          return (
            <div
              key={row.index}
              role="treeitem"
              className={isCurrent ? 'bookmarks-row bookmarks-row--current' : 'bookmarks-row'}
              data-index={row.index}
              data-depth={Math.min(row.entry.level, MAX_DEPTH)}
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
