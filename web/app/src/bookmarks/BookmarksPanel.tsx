// The bookmarks side panel (W5.2, W1.4 section 9): the document outline as a tree. Each entry with
// children has a disclosure button; a click on an entry asks the document view to scroll to its page.
// The outline is read-only here: editing, attachments and layers come later (PLAN W5.2).
import { useEffect, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { OutlineEntry } from '../rpc/generated';
import { expandedOf, setExpandedOf } from './openState';
import { initialExpanded, visibleRows } from './tree';
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

  useEffect(() => {
    let active = true;
    rpc
      .call('session.outline', { handle })
      .then((reply) => {
        if (!active) return;
        // The first load sets the expansion from the file's own flags; later loads keep the
        // user's choices for this tab.
        setExpanded(expandedOf(tabId) ?? initialExpanded(reply.entries));
        setEntries(reply.entries);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [rpc, handle, tabId]);

  const toggle = (index: number) => {
    const next = new Set(expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setExpanded(next);
    setExpandedOf(tabId, next);
  };

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

  return (
    <ul className="bookmarks-list" aria-label={t('bookmarks.list')}>
      {visibleRows(entries, expanded).map((row) => (
        <li
          key={row.index}
          className="bookmarks-row"
          data-depth={Math.min(row.entry.level, MAX_DEPTH)}
        >
          {row.hasChildren ? (
            <button
              type="button"
              className="bookmarks-toggle"
              aria-expanded={row.expanded}
              aria-label={t(row.expanded ? 'bookmarks.collapse' : 'bookmarks.expand', {
                title: row.entry.title,
              })}
              onClick={() => toggle(row.index)}
            >
              <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                <path d={row.expanded ? 'M2 4l4 4 4-4' : 'M4 2l4 4-4 4'} />
              </svg>
            </button>
          ) : (
            <span className="bookmarks-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className="bookmarks-title"
            disabled={row.entry.page === null}
            onClick={() => {
              if (row.entry.page !== null) onSelect(row.entry.page);
            }}
          >
            {row.entry.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function BookmarksPanel({ onClose, ...tree }: BookmarksPanelProps) {
  return (
    <Panel title={t('bookmarks.title')} onClose={onClose}>
      <BookmarkTree {...tree} />
    </Panel>
  );
}
