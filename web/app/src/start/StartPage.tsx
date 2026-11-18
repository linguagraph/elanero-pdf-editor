import { useId } from 'react';
import { t } from '../i18n/t';
import type { RecentFile } from '../recent/recentFiles';
import './start.css';

export interface StartPageProps {
  readonly recent: readonly RecentFile[];
  // The recent file the user picked last, if any: the page asks them to pick it again.
  readonly pickHint: string | null;
  onOpen(): void;
  onRecent(name: string): void;
  onFiles(files: readonly File[]): void;
}

// Shown when no document tab is open (W1.6 section 3). The Open button is the keyboard path to the
// file picker; the drop zone is the pointer path, and its text says the same thing for screen
// readers. Nothing here reads the file: the parent decides what a chosen file does.
export function StartPage({ recent, pickHint, onOpen, onRecent, onFiles }: StartPageProps) {
  const headingId = useId();
  const dropId = useId();
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
