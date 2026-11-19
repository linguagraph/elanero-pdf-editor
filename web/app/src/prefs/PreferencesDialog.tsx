import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Checkbox, Radio, RadioGroup, TextField, Label, Input } from 'react-aria-components';
import { t } from '../i18n/t';
import type { MessageId } from '../i18n/en';
import { Overlay } from '../layout/Overlay';
import { clearLocalData, type ClearAction } from '../storage/clearLocalData';
import {
  applyTheme,
  isThemeChoice,
  readStoredTheme,
  THEME_CHOICES,
  type ThemeChoice,
} from '../theme/theme';
import {
  AUTHOR_NAME_MAX_LENGTH,
  PAGE_LAYOUT_CHOICES,
  readPreferences,
  writePreferences,
  ZOOM_CHOICES,
  type LanguageChoice,
  type PageLayoutChoice,
  type Preferences,
  type ZoomChoice,
} from './store';
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
}

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

const PAGE_LAYOUT_LABELS: Readonly<Record<PageLayoutChoice, MessageId>> = {
  continuous: 'prefs.layout.continuous',
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
}: PreferencesDialogProps) {
  const cancel = () => {
    applyTheme(readStoredTheme());
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
}: PreferencesFormProps) {
  const [draft, setDraft] = useState<Preferences>(readPreferences);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const ids = useId();

  // The confirmation takes focus, on Keep, so Enter does not clear by accident.
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const chooseTheme = (theme: ThemeChoice) => {
    applyTheme(theme);
    update('theme', theme);
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
        <Checkbox
          className="prefs-option"
          isSelected={draft.reduceMotion}
          onChange={(selected) => update('reduceMotion', selected)}
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

      <section className="prefs-section" aria-labelledby={`${ids}-shortcuts`}>
        <h3 id={`${ids}-shortcuts`} className="prefs-heading">
          {t('prefs.section.shortcuts')}
        </h3>
        <span className="prefs-hint">{t('prefs.shortcuts.hint')}</span>
        <button type="button" className="overlay-close" onClick={onShowShortcuts}>
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
                disabled={hasDocuments || clearing}
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
            disabled={hasDocuments || clearing}
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
