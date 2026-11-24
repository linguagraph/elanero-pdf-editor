import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Checkbox, Radio, RadioGroup, TextField, Label, Input } from 'react-aria-components';
import { t } from '../i18n/t';
import type { MessageId } from '../i18n/en';
import type { FontLibrary } from '../fonts/fontLibrary';
import { Overlay } from '../layout/Overlay';
import { clearLocalData, type ClearAction } from '../storage/clearLocalData';
import type { TranslationInfoResult } from '../rpc/generated';
import { ConsentNotice } from '../translate/ConsentNotice';
import {
  agreedPatch,
  hasCurrentConsent,
  withdrawnPatch,
  type TranslationInfoLoader,
} from '../translate/consent';
import { ACCENT_CHOICES, applyAccent, isAccentChoice } from '../theme/accent';
import { applyReduceMotion } from '../theme/motion';
import type { AccentId } from '../theme/tokens';
import {
  applyTheme,
  isThemeChoice,
  readStoredTheme,
  THEME_CHOICES,
  type ThemeChoice,
} from '../theme/theme';
import {
  AUTHOR_NAME_MAX_LENGTH,
  cleanHexColour,
  cleanLanguageCode,
  DEFAULT_PREFERENCES,
  OVERLAY_TEXT_MAX_LENGTH,
  PAGE_LAYOUT_CHOICES,
  readPreferences,
  writePreferences,
  ZOOM_CHOICES,
  type LanguageChoice,
  type PageLayoutChoice,
  type Preferences,
  type ZoomChoice,
} from './store';
import { FontsSection } from './FontsSection';
import './preferences.css';

export interface PreferencesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  // True while a document is open in this tab. Clear all is then disabled (W4.5 D2): the reload
  // would lose the open documents' state.
  hasDocuments: boolean;
  // Injected for tests; the app uses the defaults.
  clearData?: ClearAction;
  reloadPage?: () => void;
  // Opens the Keyboard Shortcuts dialog above this one; the draft here is kept (W4.5 D3).
  onShowShortcuts?: () => void;
  // The translation service's languages and privacy link (translation.info). Left out in tests and
  // when the engine is not ready: the page then offers only the app's language.
  loadTranslationInfo?: TranslationInfoLoader;
  // The tab's uploaded fonts (W6.9 slice 4): the Fonts section. Tests leave it out.
  fonts?: FontLibrary;
}

// Elanero's own privacy policy, linked from the translation page and its notice (W6.6 section 13).
const ELANERO_PRIVACY_URL =
  'https://github.com/linguagraph/elanero-pdf-editor/blob/main/PRIVACY.md';

const THEME_LABELS: Readonly<Record<ThemeChoice, MessageId>> = {
  system: 'prefs.theme.system',
  light: 'prefs.theme.light',
  dark: 'prefs.theme.dark',
};

const ZOOM_LABELS: Readonly<Record<ZoomChoice, MessageId>> = {
  fitWidth: 'prefs.zoom.fitWidth',
  fitPage: 'prefs.zoom.fitPage',
  actual: 'prefs.zoom.actual',
};

const LANGUAGE_LABELS: Readonly<Record<LanguageChoice, MessageId>> = {
  en: 'prefs.language.english',
};

const ACCENT_LABELS: Readonly<Record<AccentId, MessageId>> = {
  blue: 'prefs.accent.blue',
  teal: 'prefs.accent.teal',
  green: 'prefs.accent.green',
  purple: 'prefs.accent.purple',
  pink: 'prefs.accent.pink',
  red: 'prefs.accent.red',
  orange: 'prefs.accent.orange',
  graphite: 'prefs.accent.graphite',
};

const PAGE_LAYOUT_LABELS: Readonly<Record<PageLayoutChoice, MessageId>> = {
  continuous: 'prefs.layout.continuous',
  single: 'prefs.layout.single',
  twoPage: 'prefs.layout.twoPage',
  twoPageCover: 'prefs.layout.twoPageCover',
};

// Preferences (W1.6 section 9, W4.5). Changes are drafts until Apply. The theme is the exception:
// it previews at once through the theme module, and Cancel, Escape or a tap outside puts back the
// saved one. The sections follow the desktop PreferencesDialog where they apply on the web.
export function PreferencesDialog({
  isOpen,
  onClose,
  hasDocuments,
  clearData = () => clearLocalData(),
  reloadPage = () => window.location.reload(),
  onShowShortcuts = () => undefined,
  loadTranslationInfo,
  fonts,
}: PreferencesDialogProps) {
  const cancel = () => {
    applyTheme(readStoredTheme());
    applyAccent(readPreferences().accent);
    applyReduceMotion(readPreferences().reduceMotion);
    onClose();
  };
  return (
    <Overlay isOpen={isOpen} onClose={cancel} title={t('prefs.title')} showCloseButton={false}>
      <PreferencesForm
        onApply={onClose}
        onCancel={cancel}
        hasDocuments={hasDocuments}
        clearData={clearData}
        reloadPage={reloadPage}
        onShowShortcuts={onShowShortcuts}
        loadTranslationInfo={loadTranslationInfo}
        fonts={fonts}
      />
    </Overlay>
  );
}

interface PreferencesFormProps {
  onApply: () => void;
  onCancel: () => void;
  hasDocuments: boolean;
  clearData: ClearAction;
  reloadPage: () => void;
  onShowShortcuts: () => void;
  loadTranslationInfo?: TranslationInfoLoader;
  fonts: FontLibrary | undefined;
}

// The language name in the browser's own words; the English name from the service when the browser
// does not know the code.
function languageName(code: string, fallback: string): string {
  try {
    return (
      new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'language' }).of(
        code,
      ) ?? fallback
    );
  } catch {
    return fallback;
  }
}

// Mounted only while the dialog is open (the overlay renders nothing when closed), so every open
// starts from the saved preferences.
function PreferencesForm({
  onApply,
  onCancel,
  hasDocuments,
  clearData,
  reloadPage,
  onShowShortcuts,
  loadTranslationInfo,
  fonts,
}: PreferencesFormProps) {
  const [draft, setDraft] = useState<Preferences>(readPreferences);
  const [confirming, setConfirming] = useState(false);
  const [translationInfo, setTranslationInfo] = useState<TranslationInfoResult | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  // Clear all waits for a font operation (a sync, an add, a removal): the reload would cut it short.
  const subscribeFonts = useCallback(
    (listener: () => void) => fonts?.subscribe(listener) ?? (() => undefined),
    [fonts],
  );
  const fontsBusy = useSyncExternalStore(subscribeFonts, () => fonts?.getState().busy ?? false);

  // The confirmation takes focus, on Keep, so Enter does not clear by accident.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  // The languages come from the engine once, when the dialog opens; a failure leaves the page usable.
  useEffect(() => {
    let live = true;
    loadTranslationInfo?.().then(
      (info) => live && setTranslationInfo(info),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [loadTranslationInfo]);

  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const chooseTheme = (theme: ThemeChoice) => {
    applyTheme(theme);
    update('theme', theme);
  };

  // The accent previews at once, like the theme; Cancel puts back the saved one.
  const chooseAccent = (accent: AccentId) => {
    applyAccent(accent);
    update('accent', accent);
  };

  // Reduce motion previews at once, like the accent; Cancel puts back the saved choice (W8.5 S6).
  const chooseReduceMotion = (on: boolean) => {
    applyReduceMotion(on);
    update('reduceMotion', on);
  };

  // The reload is the reset: the theme, accent, recent list and every in-memory copy start from the
  // defaults. It runs only when everything was removed; a partial clear stays on the page, with the
  // message, because the state a reload would show is then unknown.
  // The ref, not the state, is the guard: two clicks in one tick both run before React re-renders
  // and disables the button.
  const clearingRef = useRef(false);
  const clearAll = async () => {
    // A tab opened while the confirmation shows (a file still queued or opening) must block the
    // clear too: the button is disabled, and this guard keeps every other path from reloading.
    if (hasDocuments || clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    setClearFailed(false);
    const outcome = await clearData().catch(() => ({ keysRemoved: 0, complete: false }));
    if (outcome.complete) {
      reloadPage();
      return;
    }
    clearingRef.current = false;
    setClearing(false);
    setConfirming(false);
    setClearFailed(true);
  };

  // The switch: on asks for the notice (unless the current one was agreed to); off clears the
  // record, so the notice asks again. Agreeing saves at once, as the bubble will (W6.6 section 7).
  const chooseTranslation = (selected: boolean) => {
    if (!selected) {
      setDraft((previous) => ({ ...previous, ...withdrawnPatch() }));
    } else if (hasCurrentConsent(draft)) {
      update('translationEnabled', true);
    } else {
      setNoticeOpen(true);
    }
  };

  const agreeToTranslation = () => {
    const patch = agreedPatch();
    writePreferences({ ...readPreferences(), ...patch });
    setDraft((previous) => ({ ...previous, ...patch }));
    setNoticeOpen(false);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    writePreferences(draft);
    onApply();
  };

  return (
    <form className="prefs" onSubmit={submit}>
      <section className="prefs-section" aria-labelledby={`${ids}-general`}>
        <h3 id={`${ids}-general`} className="prefs-heading">
          {t('prefs.section.general')}
        </h3>
        <label className="prefs-field" htmlFor={`${ids}-language`}>
          <span className="prefs-label">{t('prefs.language.label')}</span>
          <select
            id={`${ids}-language`}
            className="prefs-select"
            value={draft.language}
            onChange={(event) => update('language', event.target.value as LanguageChoice)}
          >
            {(Object.keys(LANGUAGE_LABELS) as LanguageChoice[]).map((code) => (
              <option key={code} value={code}>
                {t(LANGUAGE_LABELS[code])}
              </option>
            ))}
          </select>
          <span className="prefs-hint">{t('prefs.language.hint')}</span>
        </label>
        <TextField
          className="prefs-field"
          value={draft.authorName}
          onChange={(value) => update('authorName', value.slice(0, AUTHOR_NAME_MAX_LENGTH))}
        >
          <Label className="prefs-label">{t('prefs.authorName.label')}</Label>
          <Input className="prefs-input" maxLength={AUTHOR_NAME_MAX_LENGTH} />
          <span className="prefs-hint">{t('prefs.authorName.hint')}</span>
        </TextField>
      </section>

      <section className="prefs-section" aria-labelledby={`${ids}-appearance`}>
        <h3 id={`${ids}-appearance`} className="prefs-heading">
          {t('prefs.section.appearance')}
        </h3>
        <RadioGroup
          className="prefs-group"
          value={draft.theme}
          onChange={(value) => {
            if (isThemeChoice(value)) chooseTheme(value);
          }}
        >
          <Label className="prefs-label">{t('prefs.theme.label')}</Label>
          {THEME_CHOICES.map((choice) => (
            <Radio key={choice} value={choice} className="prefs-option">
              {t(THEME_LABELS[choice])}
            </Radio>
          ))}
        </RadioGroup>
        <RadioGroup
          className="prefs-group"
          value={draft.accent}
          onChange={(value) => {
            if (isAccentChoice(value)) chooseAccent(value);
          }}
        >
          <Label className="prefs-label">{t('prefs.accent.label')}</Label>
          {ACCENT_CHOICES.map((choice) => (
            <Radio key={choice} value={choice} className="prefs-option prefs-accent">
              <span className="prefs-swatch" data-swatch={choice} aria-hidden="true" />
              {t(ACCENT_LABELS[choice])}
            </Radio>
          ))}
        </RadioGroup>
        <Checkbox
          className="prefs-option"
          isSelected={draft.ribbonCompact}
          onChange={(selected) => update('ribbonCompact', selected)}
        >
          {t('prefs.ribbonCompact')}
        </Checkbox>
        <Checkbox
          className="prefs-option"
          isSelected={draft.reduceMotion}
          onChange={chooseReduceMotion}
        >
          {t('prefs.reduceMotion.label')}
        </Checkbox>
        <span className="prefs-hint">{t('prefs.reduceMotion.hint')}</span>
      </section>

      <section className="prefs-section" aria-labelledby={`${ids}-viewing`}>
        <h3 id={`${ids}-viewing`} className="prefs-heading">
          {t('prefs.section.viewing')}
        </h3>
        <label className="prefs-field" htmlFor={`${ids}-zoom`}>
          <span className="prefs-label">{t('prefs.zoom.label')}</span>
          <select
            id={`${ids}-zoom`}
            className="prefs-select"
            value={draft.defaultZoom}
            onChange={(event) => update('defaultZoom', event.target.value as ZoomChoice)}
          >
            {ZOOM_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t(ZOOM_LABELS[choice])}
              </option>
            ))}
          </select>
          <span className="prefs-hint">{t('prefs.zoom.hint')}</span>
        </label>
        <label className="prefs-field" htmlFor={`${ids}-layout`}>
          <span className="prefs-label">{t('prefs.layout.label')}</span>
          <select
            id={`${ids}-layout`}
            className="prefs-select"
            value={draft.pageLayout}
            onChange={(event) => update('pageLayout', event.target.value as PageLayoutChoice)}
          >
            {PAGE_LAYOUT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t(PAGE_LAYOUT_LABELS[choice])}
              </option>
            ))}
          </select>
          <span className="prefs-hint">{t('prefs.layout.hint')}</span>
        </label>
      </section>

      <section className="prefs-section" aria-labelledby={`${ids}-translation`}>
        <h3 id={`${ids}-translation`} className="prefs-heading">
          {t('prefs.section.translation')}
        </h3>
        <Checkbox
          className="prefs-option"
          isSelected={draft.translationEnabled}
          onChange={chooseTranslation}
        >
          {t('prefs.translation.enable')}
        </Checkbox>
        <label className="prefs-field" htmlFor={`${ids}-translation-language`}>
          <span className="prefs-label">{t('prefs.translation.language')}</span>
          <select
            id={`${ids}-translation-language`}
            className="prefs-select"
            value={draft.translationTarget}
            disabled={!draft.translationEnabled}
            onChange={(event) => update('translationTarget', cleanLanguageCode(event.target.value))}
          >
            <option value="">{t('prefs.translation.sameAsApp')}</option>
            {(translationInfo?.languages.mymemory ?? []).map((language) => (
              <option key={language.code} value={language.code}>
                {languageName(language.code, language.name)}
              </option>
            ))}
          </select>
          <span className="prefs-hint">{t('prefs.translation.languageHint')}</span>
        </label>
        <span className="prefs-hint">{t('prefs.translation.note')}</span>
        <p className="prefs-hint">
          {translationInfo === null ? null : (
            <a
              href={translationInfo.services[0]?.privacy_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('prefs.translation.mymemoryPrivacy')}
            </a>
          )}
        </p>
        <p className="prefs-hint">
          <a href={ELANERO_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            {t('prefs.translation.elaneroPrivacy')}
          </a>
        </p>
        <ConsentNotice
          isOpen={noticeOpen}
          privacyUrl={translationInfo?.services[0]?.privacy_url}
          onAgree={agreeToTranslation}
          onCancel={() => setNoticeOpen(false)}
        />
      </section>

      <section className="prefs-section" aria-labelledby={`${ids}-redaction`}>
        <h3 id={`${ids}-redaction`} className="prefs-heading">
          {t('prefs.section.redaction')}
        </h3>
        <span className="prefs-hint">{t('prefs.redaction.hint')}</span>
        <label className="prefs-field" htmlFor={`${ids}-redaction-fill`}>
          <span className="prefs-label">{t('prefs.redaction.fill')}</span>
          <input
            id={`${ids}-redaction-fill`}
            type="color"
            className="prefs-colour"
            value={draft.redactionFill}
            onChange={(event) =>
              update(
                'redactionFill',
                cleanHexColour(event.target.value, DEFAULT_PREFERENCES.redactionFill),
              )
            }
          />
        </label>
        <label className="prefs-field" htmlFor={`${ids}-redaction-text`}>
          <span className="prefs-label">{t('prefs.redaction.textColor')}</span>
          <input
            id={`${ids}-redaction-text`}
            type="color"
            className="prefs-colour"
            value={draft.redactionTextColor}
            onChange={(event) =>
              update(
                'redactionTextColor',
                cleanHexColour(event.target.value, DEFAULT_PREFERENCES.redactionTextColor),
              )
            }
          />
        </label>
        <TextField
          className="prefs-field"
          value={draft.redactionOverlayText}
          onChange={(value) =>
            update('redactionOverlayText', value.slice(0, OVERLAY_TEXT_MAX_LENGTH))
          }
        >
          <Label className="prefs-label">{t('prefs.redaction.overlayText')}</Label>
          <Input className="prefs-input" maxLength={OVERLAY_TEXT_MAX_LENGTH} />
          <span className="prefs-hint">{t('prefs.redaction.overlayHint')}</span>
        </TextField>
      </section>

      {fonts === undefined ? null : <FontsSection library={fonts} />}

      <section className="prefs-section" aria-labelledby={`${ids}-shortcuts`}>
        <h3 id={`${ids}-shortcuts`} className="prefs-heading">
          {t('prefs.section.shortcuts')}
        </h3>
        <span className="prefs-hint">{t('prefs.shortcuts.hint')}</span>
        <button type="button" className="prefs-action" onClick={onShowShortcuts}>
          {t('prefs.shortcuts.open')}
        </button>
      </section>

      <section className="prefs-section" aria-labelledby={`${ids}-privacy`}>
        <h3 id={`${ids}-privacy`} className="prefs-heading">
          {t('prefs.section.privacy')}
        </h3>
        <span className="prefs-hint">{t('prefs.clearAll.hint')}</span>
        {confirming ? (
          <div className="prefs-confirm" role="group" aria-label={t('prefs.clearAll.confirm')}>
            <span>{t('prefs.clearAll.confirm')}</span>
            <div className="prefs-confirm-actions">
              <button
                type="button"
                className="overlay-close prefs-danger"
                disabled={hasDocuments || clearing || fontsBusy}
                onClick={() => void clearAll()}
              >
                {t('prefs.clearAll.clear')}
              </button>
              <button
                ref={keepRef}
                type="button"
                className="overlay-close"
                disabled={clearing}
                onClick={() => setConfirming(false)}
              >
                {t('prefs.clearAll.keep')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="overlay-close prefs-danger"
            disabled={hasDocuments || clearing || fontsBusy}
            onClick={() => setConfirming(true)}
          >
            {t('prefs.clearAll.open')}
          </button>
        )}
        {hasDocuments ? <span className="prefs-hint">{t('prefs.clearAll.blocked')}</span> : null}
        {clearFailed ? (
          <span className="prefs-error" role="alert">
            {t('prefs.clearAll.incomplete')}
          </span>
        ) : null}
      </section>

      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onCancel}>
          {t('prefs.cancel')}
        </button>
        <button type="submit" className="overlay-close prefs-apply">
          {t('prefs.apply')}
        </button>
      </div>
    </form>
  );
}
