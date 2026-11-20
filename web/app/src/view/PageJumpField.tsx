// The page jump field (W5.3, W1.6 section 9), shared by the canvas pill: a text field that takes a
// page label or a one-based page number. A bad entry shows the invalid message and does not move.
import { type FormEvent, forwardRef, useState } from 'react';
import { t } from '../i18n/t';
import { pageLabelFor, parsePageInput } from './navigation';

export interface PageJumpFieldProps {
  // One-based page at the middle of the viewport, and the number of pages.
  readonly page: number;
  readonly total: number;
  readonly labels?: readonly string[];
  // Called with a zero-based page index when a jump names a page.
  readonly onGoTo: (index: number) => void;
}

// The input's ref is forwarded, so the host can focus the field (the status bar's Go to Page, W4.3b).
export const PageJumpField = forwardRef<HTMLInputElement, PageJumpFieldProps>(
  function PageJumpField({ page, total, labels, onGoTo }, ref) {
    const currentLabel = pageLabelFor(page - 1, labels);
    // The text being typed; null while the field shows the current page.
    const [draft, setDraft] = useState<string | null>(null);
    const [invalid, setInvalid] = useState<string | null>(null);

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
      <form className="canvas-pill-jump" onSubmit={submit}>
        <input
          ref={ref}
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
        <span className="canvas-pill-total">{t('pill.pageCount', { total })}</span>
        {invalid === null ? null : (
          <span role="alert" className="canvas-pill-error">
            {invalid}
          </span>
        )}
      </form>
    );
  },
);
