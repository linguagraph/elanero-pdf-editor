// Preferences ▸ Fonts (W6.9 slice 4, design section 4). Lists the tab's uploaded fonts, adds files and
// removes them. Changes apply at once, not on Apply, as Clear all does; the hint says so.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatMegabytes } from '../i18n/format';
import { t, tp } from '../i18n/t';
import {
  type AddOutcome,
  type FontLibrary,
  type LibraryFont,
  MAX_FONT_FILE_BYTES,
  useFontLibrary,
} from '../fonts/fontLibrary';
import { describeAddOutcome, type UploadMessage } from '../fonts/uploadMessages';
import { FONT_ACCEPT, useFontUpload } from '../fonts/useFontUpload';

export interface FontsSectionProps {
  readonly library: FontLibrary;
}

// The one confirmation open at a time: a single font's (in its row) or all of them (at the foot).
type Confirm = { readonly kind: 'one'; readonly id: string } | { readonly kind: 'all' };

function familyNames(font: LibraryFont): string {
  const dto = font.dto;
  if (dto === undefined || dto.faces.length === 0) return font.name;
  return [...new Set(dto.faces.map((face) => face.family))].join(', ');
}

export function FontsSection({ library }: FontsSectionProps) {
  const state = useFontLibrary(library);
  const ids = useId();
  const [messages, setMessages] = useState<readonly UploadMessage[]>([]);
  const [confirm, setConfirm] = useState<Confirm>();
  const keepRef = useRef<HTMLButtonElement>(null);
  const busy = state.busy;

  // The confirmation takes focus, on Keep, so Enter does not remove by accident.
  useEffect(() => {
    if (confirm !== undefined) keepRef.current?.focus();
  }, [confirm]);

  const report = useCallback(
    (file: File, outcome: AddOutcome) => {
      const message = describeAddOutcome(outcome, file.name, library.getState().usedBytes);
      setMessages((previous) => [...previous, message]);
    },
    [library],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useFontUpload(library, report, inputRef);

  // Each removal reports one line. A failed removal says so in the alert area.
  const removeFont = async (font: LibraryFont) => {
    setConfirm(undefined);
    const outcome = await library.remove(font.id).catch(() => ({ kind: 'notRemoved' as const }));
    const name = font.name;
    setMessages([
      outcome.kind === 'removed'
        ? { tone: 'status', text: t('fonts.removed', { name }) }
        : outcome.kind === 'engineKept'
          ? { tone: 'status', text: t('fonts.remove.partial', { name }) }
          : { tone: 'alert', text: t('fonts.remove.failed', { name }) },
    ]);
  };

  const removeEverything = async () => {
    setConfirm(undefined);
    const outcome = await library.removeAll().catch(() => ({ kind: 'notRemoved' as const }));
    setMessages([
      outcome.kind === 'notRemoved'
        ? { tone: 'alert', text: t('fonts.removeAll.failed') }
        : { tone: 'status', text: t('fonts.removedAll') },
    ]);
  };

  const statusLines = messages.filter((message) => message.tone === 'status');
  const alertLines = messages.filter((message) => message.tone === 'alert');

  let list;
  if (state.syncing) {
    list = <p className="prefs-hint">{t('fonts.loading')}</p>;
  } else if (state.fonts.length === 0) {
    list = <p className="prefs-hint">{t('fonts.list.empty')}</p>;
  } else {
    list = (
      <ul role="list" className="fonts-list">
        {state.fonts.map((font) => (
          <li key={font.id} className="fonts-row">
            <div className="fonts-name">
              <span>{familyNames(font)}</span>
              <span className="prefs-hint">{font.name}</span>
              <span className="prefs-hint">{formatMegabytes(font.size)}</span>
              {font.loaded ? null : <span className="prefs-hint">{t('fonts.row.notLoaded')}</span>}
              {font.dto !== undefined && font.dto.format === 'collection' ? (
                <span className="prefs-hint">{tp('fonts.row.faces', font.dto.faces.length)}</span>
              ) : null}
            </div>
            <button
              type="button"
              className="prefs-action"
              disabled={busy}
              aria-label={t('fonts.remove.label', { name: font.name })}
              onClick={() => setConfirm({ kind: 'one', id: font.id })}
            >
              {t('fonts.remove')}
            </button>
            {confirm?.kind === 'one' && confirm.id === font.id ? (
              <div
                className="prefs-confirm"
                role="group"
                aria-label={t('fonts.removeConfirm', { name: font.name })}
              >
                <span>{t('fonts.removeConfirm', { name: font.name })}</span>
                <div className="prefs-confirm-actions">
                  <button
                    type="button"
                    className="overlay-close prefs-danger"
                    disabled={busy}
                    onClick={() => void removeFont(font)}
                  >
                    {t('fonts.confirm.remove')}
                  </button>
                  <button
                    ref={keepRef}
                    type="button"
                    className="overlay-close"
                    onClick={() => setConfirm(undefined)}
                  >
                    {t('fonts.confirm.keep')}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="prefs-section" aria-labelledby={`${ids}-fonts`}>
      <h3 id={`${ids}-fonts`} className="prefs-heading">
        {t('fonts.section')}
      </h3>
      <span className="prefs-hint">{t('fonts.hint')}</span>
      {state.storage === 'session' ? (
        <span className="prefs-hint">{t('fonts.storage.sessionOnly')}</span>
      ) : null}
      {list}
      <span className="prefs-hint">
        {t('fonts.usage', {
          used: formatMegabytes(state.usedBytes),
          max: formatMegabytes(state.maxBytes),
        })}
      </span>
      <div className="fonts-actions">
        <button
          type="button"
          className="prefs-action"
          disabled={busy}
          onClick={() => upload.open()}
        >
          {t('fonts.upload.button')}
        </button>
        <button
          type="button"
          className="prefs-action"
          disabled={busy || state.fonts.length === 0}
          onClick={() => setConfirm({ kind: 'all' })}
        >
          {t('fonts.removeAll')}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={FONT_ACCEPT}
        hidden
        aria-label={t('fonts.upload.button')}
        onChange={(event) => {
          setMessages([]);
          upload.onChange(event);
        }}
      />
      <span className="prefs-hint">
        {t('fonts.upload.accept', { limit: formatMegabytes(MAX_FONT_FILE_BYTES) })}
      </span>
      {confirm?.kind === 'all' ? (
        <div
          className="prefs-confirm"
          role="group"
          aria-label={tp('fonts.removeAllConfirm', state.fonts.length)}
        >
          <span>{tp('fonts.removeAllConfirm', state.fonts.length)}</span>
          <div className="prefs-confirm-actions">
            <button
              type="button"
              className="overlay-close prefs-danger"
              disabled={busy}
              onClick={() => void removeEverything()}
            >
              {t('fonts.confirm.remove')}
            </button>
            <button
              ref={keepRef}
              type="button"
              className="overlay-close"
              onClick={() => setConfirm(undefined)}
            >
              {t('fonts.confirm.keep')}
            </button>
          </div>
        </div>
      ) : null}
      <div role="status" className="fonts-messages">
        {statusLines.map((message, index) => (
          <p key={`s${index}`}>{message.text}</p>
        ))}
      </div>
      <div role="alert" className="fonts-messages">
        {alertLines.map((message, index) => (
          <p key={`a${index}`} className="prefs-error">
            {message.text}
          </p>
        ))}
      </div>
    </section>
  );
}
