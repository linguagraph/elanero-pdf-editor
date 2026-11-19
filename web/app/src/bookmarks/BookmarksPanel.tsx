// The bookmarks side panel (W5.2, W1.4 section 9): the document outline as a tree (ARIA tree roles,
// with the arrow keys of the tree pattern). A click on an entry, or Enter on it, asks the document
// view to scroll to its page. The outline is read-only here: editing, attachments and layers come
// later (PLAN W5.2).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { OutlineEntry } from '../rpc/generated';
import { expandedOf, setExpandedOf } from './openState';
import { initialExpanded, treeAction, visibleRows } from './tree';
import './bookmarks.css';

export interface BookmarksPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // The tab the panel belongs to: its expansion state is kept per tab.
  readonly tabId: number;
  // Called with the page index (zero-based) when an entry with a page is chosen.
  readonly onSelect: (index: number) => void;
  readonly onClose: () => void;
}

// The deepest indent the stylesheet has a rule for; deeper entries share its indent.
const MAX_DEPTH = 8;

function BookmarkTree({ rpc, handle, tabId, onSelect }: Omit<BookmarksPanelProps, 'onClose'>) {
  const [entries, setEntries] = useState<readonly OutlineEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  // The row that has the focus (roving tabindex); null until the user reaches the tree.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    rpc
      .call('session.outline', { handle })
      .then((reply) => {
        if (!active) return;
        // The first load sets the expansion from the file's own flags; later loads of the same
        // outline keep the user's choices for this tab.
        setExpanded(expandedOf(tabId, reply.entries.length) ?? initialExpanded(reply.entries));
        setEntries(reply.entries);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [rpc, handle, tabId]);

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

  const toggle = (index: number) => {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
    setExpandedOf(tabId, entries.length, next);
  };
  const focusRow = (index: number) => {
    setFocusIndex(index);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };
  const choose = (index: number) => {
    const page = entries[index]?.page;
    if (page !== null && page !== undefined) onSelect(page);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const action = treeAction(rows, event.key, index);
    if (action.kind === 'none') return;
    event.preventDefault();
    if (action.kind === 'focus') focusRow(action.index);
    else if (action.kind === 'expand' || action.kind === 'collapse') toggle(action.index);
    else choose(action.index);
  };

  return (
    <div
      ref={listRef}
      role="tree"
      className="bookmarks-list panel-fill"
      aria-label={t('bookmarks.list')}
    >
      {rows.map((row) => (
        <div
          key={row.index}
          role="treeitem"
          className="bookmarks-row"
          data-index={row.index}
          data-depth={Math.min(row.entry.level, MAX_DEPTH)}
          aria-level={row.entry.level}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-disabled={row.entry.page === null ? true : undefined}
          tabIndex={row.index === activeIndex ? 0 : -1}
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
          <span className="bookmarks-title">{row.entry.title}</span>
        </div>
      ))}
    </div>
  );
}

export function BookmarksPanel({ onClose, ...tree }: BookmarksPanelProps) {
  return (
    <Panel title={t('bookmarks.title')} onClose={onClose}>
      <BookmarkTree {...tree} />
    </Panel>
  );
}
