import { type ReactNode, useId, useState } from 'react';
import { SOURCE_URL } from '../about';
import type { PendingOpen } from '../documents/useDocuments';
import { formatDate } from '../i18n/format';
import { t } from '../i18n/t';
import type { RecentFile } from '../recent/recentFiles';
import { Icon } from '../theme/Icon';
import { APP_VERSION } from '../version';
import './start.css';

export interface StartPageProps {
  readonly recent: readonly RecentFile[];
  // The recent file the user picked last, if any: the page asks them to pick it again.
  readonly pickHint: string | null;
  // The first-page previews by recent name, as object URLs (issue 757). A name without one shows
  // the file icon in the same box.
  readonly thumbs?: ReadonlyMap<string, string>;
  // The engine's load stages, shown in place of the quick actions while it loads (W3.1).
  readonly loading?: ReactNode;
  // The files waiting for the engine, and the call that drops one of them.
  readonly pending?: readonly PendingOpen[];
  onCancelPending?(id: number): void;
  onOpen(): void;
  onRecent(name: string): void;
  onFiles(files: readonly File[]): void;
  // Keeps the file handles of a drop, for Open recent (issue 756). Optional: tests leave it out.
  onDroppedHandles?(data: DataTransfer): void;
  // Opens the About overlay from the footer (the same overlay as the app menu).
  onAbout(): void;
}

// Shown when no document tab is open (W1.6 section 3). The Open button is the keyboard path to the
// file picker; a PDF dropped anywhere on the page opens too (the card lights up while one is over
// the page), and the card's text says the same thing for screen readers. Nothing here reads the
// file: the parent decides what a chosen file does.
export function StartPage({
  recent,
  pickHint,
  thumbs,
  loading,
  pending = [],
  onCancelPending,
  onOpen,
  onRecent,
  onFiles,
  onDroppedHandles,
  onAbout,
}: StartPageProps) {
  const headingId = useId();
  const dropId = useId();
  const pendingId = useId();
  const recentId = useId();
  const [dragging, setDragging] = useState(false);
  return (
    <section
      className="start-page"
      aria-labelledby={headingId}
      onDragEnter={(event) => {
        event.preventDefault();
        // Only a drag that carries files lights the card; dragged text does not (it is not a PDF).
        if (isFileDrag(event)) setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        // Leaving one child for another keeps the state; only leaving the page clears it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        onDroppedHandles?.(event.dataTransfer);
        onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="start-hero">
        <img
          className="start-logo"
          src={`${import.meta.env.BASE_URL}icons/elanero-256.png`}
          alt={''}
          width={64}
          height={64}
        />
        <div>
          <h1 className="start-title">{t('app.name')}</h1>
          <p className="start-tagline">{t('start.tagline')}</p>
        </div>
      </div>
      <div className="start-open-block">
        <h2 id={headingId} className="start-heading">
          {t('start.heading')}
        </h2>
        <div
          className="start-drop"
          aria-describedby={dropId}
          data-dragging={dragging ? 'true' : undefined}
        >
          <span className="start-drop-icon" aria-hidden="true">
            <Icon name="upload" size={32} />
          </span>
          <p id={dropId} className="start-drop-text">
            {t('start.drop')}
          </p>
          <p className="start-drop-or">{t('start.drop.or')}</p>
          <button type="button" className="start-open" onClick={onOpen}>
            <Icon name="folder-open" />
            {t('start.open')}
          </button>
        </div>
      </div>
      {loading ?? null}
      {pending.length === 0 ? null : (
        <section className="start-pending" aria-labelledby={pendingId}>
          <h2 id={pendingId} className="start-recent-heading">
            {t('start.pending.heading')}
          </h2>
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
        <h2 id={recentId} className="start-recent-heading">
          {t('start.recent.heading')}
        </h2>
        {recent.length === 0 ? (
          <p>{t('start.recent.empty')}</p>
        ) : (
          <ul className="start-recent-list">
            {recent.map((entry) => (
              <li key={`${entry.name}-${entry.openedAt}`} className="start-recent-card">
                {/* The button's accessible name is the file name alone: the preview is decorative
                    and the opened time sits outside the button. */}
                <button
                  type="button"
                  className="start-recent-name"
                  onClick={() => {
                    onRecent(entry.name);
                  }}
                >
                  <span className="start-recent-thumb" aria-hidden="true">
                    {thumbs?.has(entry.name) ? (
                      <img src={thumbs.get(entry.name)} alt={''} />
                    ) : (
                      <Icon name="file" size={24} />
                    )}
                  </span>
                  <span className="start-recent-file">{entry.name}</span>
                </button>
                <span className="start-recent-time">
                  {t('start.recent.opened', { time: formatOpened(entry.openedAt) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <footer className="start-footer">
        <span>{t('start.footer.version', { version: APP_VERSION })}</span>
        <span>{t('about.licence')}</span>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('about.source')}
        </a>
        <button type="button" className="start-footer-button" onClick={onAbout}>
          {t('about.title')}
        </button>
      </footer>
    </section>
  );
}

// True when the drag carries files (the browser lists them as "Files" in dataTransfer.types).
function isFileDrag(event: { readonly dataTransfer?: DataTransfer | null }): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

// The local date and time of an opening, in the browser's own format.
export function formatOpened(openedAt: number): string {
  return formatDate(openedAt);
}
