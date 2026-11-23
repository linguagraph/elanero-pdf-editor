// The translation bubble (W6.6 section 8): From and To pickers, the translation, Copy and Add as
// note. It opens only after the consent check (TranslateFlow), so every request it makes is one the
// user agreed to. It closes on Escape, a click outside, a new selection, a scroll or a resize, and a
// reply that arrives after it closed (or after a newer run) is dropped.
import { useEffect, useRef, useState } from 'react';
import { mapRpcError } from '../rpc/errors';
import { RpcError } from '../rpc/client';
import type { TranslationInfoResult } from '../rpc/generated';
import { readPreferences, writePreferences } from '../prefs/store';
import { t } from '../i18n/t';
import { anchorRect, placeSpot } from '../text/placement';
import type { TranslationInfoLoader } from './consent';
import {
  copyText,
  defaultLanguages,
  runTranslation,
  type SelectionSnapshot,
  type TranslateCall,
  type TranslateOutcome,
} from './runTranslation';

const BUBBLE_WIDTH = 340;

// A language's name in the app's language, from the browser; the service's own name when the
// browser has none for the code.
function languageName(code: string, fallback: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? fallback;
  } catch {
    return fallback;
  }
}

function toRpcError(error: unknown): RpcError {
  return error instanceof RpcError ? error : new RpcError('ENGINE_ERROR', '');
}

export interface TranslateBubbleProps {
  readonly snapshot: SelectionSnapshot;
  readonly read: () => SelectionSnapshot | null;
  readonly loadInfo: TranslationInfoLoader;
  readonly translate: TranslateCall;
  readonly onAddNote: (note: string) => void;
  readonly onClose: () => void;
}

export function TranslateBubble({
  snapshot,
  read,
  loadInfo,
  translate,
  onAddNote,
  onClose,
}: TranslateBubbleProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [spot] = useState(() => {
    const rect = anchorRect(window.getSelection());
    return rect === null ? null : placeSpot(rect, BUBBLE_WIDTH);
  });
  const [languages, setLanguages] = useState<TranslationInfoResult['languages']['mymemory']>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loadError, setLoadError] = useState<RpcError | null>(null);
  // The last reply, with the From and To it was asked for. A reply is shown only while those are
  // still the choice, so a change of language shows the wait until its own reply arrives.
  const [reply, setReply] = useState<{
    readonly key: string;
    readonly outcome: TranslateOutcome;
  } | null>(null);
  // Each run takes a number; a reply for an older run, or after the bubble closed, is dropped.
  const run = useRef(0);

  useEffect(() => {
    let live = true;
    loadInfo().then(
      (info) => {
        if (!live) return;
        const list = info.languages.mymemory ?? [];
        setLanguages(list);
        const defaults = defaultLanguages(
          list.map((language) => language.code),
          readPreferences(),
        );
        setFrom(defaults.source);
        setTo(defaults.target);
      },
      (error: unknown) => {
        if (live) setLoadError(toRpcError(error));
      },
    );
    return () => {
      live = false;
    };
  }, [loadInfo]);

  const key = `${from}|${to}`;
  useEffect(() => {
    if (from === '' || to === '') return undefined;
    const id = ++run.current;
    void runTranslation(translate, { text: snapshot.text, source: from, target: to }).then(
      (outcome) => {
        if (id === run.current) setReply({ key, outcome });
      },
    );
    return () => {
      run.current += 1;
    };
  }, [from, to, key, snapshot.text, translate]);

  const outcome: TranslateOutcome | null =
    loadError !== null
      ? { kind: 'failed', error: loadError, partial: '' }
      : reply !== null && reply.key === key
        ? reply.outcome
        : null;
  const busy = outcome === null && from !== '' && to !== '';

  // A new selection, a click outside, a scroll or a resize closes the bubble: the selection it
  // translated is no longer the one on the page.
  useEffect(() => {
    const onSelection = () => {
      const now = read();
      if (now === null || now.text !== snapshot.text) onClose();
    };
    const outside = (event: Event) => {
      if (!boxRef.current?.contains(event.target as Node)) onClose();
    };
    // Escape closes from anywhere in the document: the bubble takes no focus (a focus move can
    // clear the DOM selection and close it through selectionchange), so the key is read here.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onEscape);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onEscape);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', onClose);
    };
  }, [read, snapshot.text, onClose]);

  const chooseFrom = (code: string) => {
    setFrom(code);
    // The From choice is remembered, so the next selection starts with it (W6.6 section 5).
    writePreferences({ ...readPreferences(), translationLastSource: code });
  };
  const swap = () => {
    setFrom(to);
    setTo(from);
  };

  const shown = outcome === null ? '' : outcome.kind === 'done' ? outcome.text : outcome.partial;
  const failure = outcome?.kind === 'failed' ? mapRpcError(outcome.error) : null;
  const options = languages.map((language) => (
    <option key={language.code} value={language.code}>
      {languageName(language.code, language.name)}
    </option>
  ));

  return (
    <div
      ref={boxRef}
      role="dialog"
      tabIndex={-1}
      aria-label={t('translate.bubble.label')}
      className="translate-bubble"
      data-above={spot?.above ? 'true' : undefined}
      style={spot === null ? undefined : { top: spot.top, left: spot.left }}
    >
      <div className="translate-bubble__langs">
        <label>
          <span>{t('translate.bubble.from')}</span>
          <select value={from} onChange={(event) => chooseFrom(event.target.value)}>
            {options}
          </select>
        </label>
        <button type="button" aria-label={t('translate.bubble.swap')} onClick={swap}>
          {'⇄'}
        </button>
        <label>
          <span>{t('translate.bubble.to')}</span>
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            {options}
          </select>
        </label>
      </div>
      <div className="translate-bubble__result" aria-live="polite">
        {busy ? <p role="status">{t('translate.bubble.busy')}</p> : null}
        {shown === '' ? null : <p className="translate-bubble__text">{shown}</p>}
        {failure === null ? null : (
          <p className="translate-bubble__error">{t(failure.messageId)}</p>
        )}
        {outcome?.kind === 'failed' && outcome.partial !== '' ? (
          <p className="translate-bubble__error">{t('translate.bubble.partial')}</p>
        ) : null}
      </div>
      <p className="translate-bubble__credit">{t('translate.bubble.credit')}</p>
      <div className="translate-bubble__actions">
        <button type="button" disabled={shown === ''} onClick={() => copyText(shown)}>
          {t('translate.bubble.copy')}
        </button>
        <button type="button" disabled={shown === '' || busy} onClick={() => void onAddNote(shown)}>
          {t('translate.bubble.addNote')}
        </button>
        <button type="button" onClick={onClose}>
          {t('translate.bubble.close')}
        </button>
      </div>
    </div>
  );
}
