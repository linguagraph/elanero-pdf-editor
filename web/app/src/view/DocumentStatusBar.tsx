// The status bar under the document (W1.6 section 1, the status bar region): the page the reader is
// on, of the total, the page jump, Back and Forward through the navigation history (W5.3), and the
// zoom. The page and zoom come from the document view, which reports them.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { pageLabelFor, parsePageInput } from './navigation';
import './documentView.css';

export interface DocumentStatusBarProps {
  // One-based page at the middle of the viewport, and the number of pages in the document.
  readonly page: number;
  readonly total: number;
  readonly zoom: number;
  // The document's page labels, when it has them (one per page, empty for none).
  readonly labels?: readonly string[];
  readonly canBack: boolean;
  readonly canForward: boolean;
  // Called with a zero-based page index when a jump names a page.
  readonly onGoTo: (index: number) => void;
  readonly onBack: () => void;
  readonly onForward: () => void;
}

export function DocumentStatusBar({
  page,
  total,
  zoom,
  labels,
  canBack,
  canForward,
  onGoTo,
  onBack,
  onForward,
}: DocumentStatusBarProps) {
  const currentLabel = pageLabelFor(page - 1, labels);
  // The text being typed; null while the field shows the current page.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Alt+Left and Alt+Right move through the history, Alt+G goes to the page field (W1.6 section 9).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onBack();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onForward();
      } else if (event.key.toLowerCase() === 'g') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack, onForward]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft ?? currentLabel;
    const index = parsePageInput(text, total, labels);
    if (index === null) {
      setInvalid(t('view.jumpInvalid', { input: text.trim(), total }));
      return;
    }
    setInvalid(null);
    setDraft(null);
    onGoTo(index);
  };

  return (
    <div className="doc-status">
      <button type="button" onClick={onBack} disabled={!canBack}>
        {t('view.back')}
      </button>
      <button type="button" onClick={onForward} disabled={!canForward}>
        {t('view.forward')}
      </button>
      <form className="doc-status-jump" onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          inputMode="text"
          aria-label={t('view.goToPage')}
          aria-invalid={invalid !== null}
          value={draft ?? currentLabel}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(null);
          }}
          onBlur={() => {
            setDraft(null);
            setInvalid(null);
          }}
        />
        <span className="doc-status-page" aria-live="polite">
          {t('view.pageNumber', { page: currentLabel, total })}
        </span>
      </form>
      {invalid === null ? null : (
        <span role="alert" className="doc-status-error">
          {invalid}
        </span>
      )}
      <span className="doc-status-zoom">
        {t('view.zoomPercent', { percent: Math.round(zoom * 100) })}
      </span>
    </div>
  );
}
