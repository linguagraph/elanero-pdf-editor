import { type ReactNode, useId } from 'react';
import type { PendingOpen } from '../documents/useDocuments';
import { t } from '../i18n/t';
import type { RecentFile } from '../recent/recentFiles';
import './start.css';

export interface StartPageProps {
  readonly recent: readonly RecentFile[];
  // The recent file the user picked last, if any: the page asks them to pick it again.
  readonly pickHint: string | null;
  // The engine's load stages, shown in place of the quick actions while it loads (W3.1).
  readonly loading?: ReactNode;
  // The files waiting for the engine, and the call that drops one of them.
  readonly pending?: readonly PendingOpen[];
  onCancelPending?(id: number): void;
  onOpen(): void;
  onRecent(name: string): void;
  onFiles(files: readonly File[]): void;
}

// Shown when no document tab is open (W1.6 section 3). The Open button is the keyboard path to the
// file picker; the drop zone is the pointer path, and its text says the same thing for screen
// readers. Nothing here reads the file: the parent decides what a chosen file does.
export function StartPage({
  recent,
  pickHint,
  loading,
  pending = [],
  onCancelPending,
  onOpen,
  onRecent,
  onFiles,
}: StartPageProps) {
  const headingId = useId();
  const dropId = useId();
  const pendingId = useId();
  const recentId = useId();
  return (
    <section className="start-page" aria-labelledby={headingId}>
      <h2 id={headingId} className="start-heading">
        {t('start.heading')}
      </h2>
      <div
        className="start-drop"
        aria-describedby={dropId}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          onFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <p id={dropId} className="start-drop-text">
          {t('start.drop')}
        </p>
        <button type="button" className="start-open" onClick={onOpen}>
          {t('start.open')}
        </button>
      </div>
      {loading ?? null}
      {pending.length === 0 ? null : (
        <section className="start-pending" aria-labelledby={pendingId}>
          <h3 id={pendingId} className="start-recent-heading">
            {t('start.pending.heading')}
          </h3>
          <ul className="start-pending-list">
            {pending.map((entry) => (
              <li key={entry.id}>
                <span>{t('start.pending.row', { name: entry.name })}</span>{' '}
                <button
                  type="button"
                  className="start-pending-cancel"
                  aria-label={t('start.pending.cancelLabel', { name: entry.name })}
                  onClick={() => {
                    onCancelPending?.(entry.id);
                  }}
                >
                  {t('start.pending.cancel')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pickHint === null ? null : (
        <p role="status" className="start-hint">
          {t('start.recent.pickAgain', { name: pickHint })}
        </p>
      )}
      <section className="start-recent" aria-labelledby={recentId}>
        <h3 id={recentId} className="start-recent-heading">
          {t('start.recent.heading')}
        </h3>
        {recent.length === 0 ? (
          <p>{t('start.recent.empty')}</p>
        ) : (
          <ul className="start-recent-list">
            {recent.map((entry) => (
              <li key={`${entry.name}-${entry.openedAt}`}>
                <button
                  type="button"
                  className="start-recent-name"
                  onClick={() => {
                    onRecent(entry.name);
                  }}
                >
                  {entry.name}
                </button>{' '}
                <span className="start-recent-time">
                  {t('start.recent.opened', { time: formatOpened(entry.openedAt) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

// The local date and time of an opening, in the browser's own format.
export function formatOpened(openedAt: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(openedAt),
  );
}
