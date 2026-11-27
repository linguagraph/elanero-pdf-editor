import { useState } from 'react';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { ThemeIcon } from './icons';
import { readStoredTheme, setTheme, THEME_CHOICES, type ThemeChoice } from './theme';
import './ThemeSwitch.css';

// The labels are the Preferences dialog's theme texts, so both places say the same thing. They are
// the accessible names and the tooltips; the switch shows only the icons.
const LABELS: Record<ThemeChoice, MessageId> = {
  system: 'theme.system',
  light: 'prefs.theme.light',
  dark: 'prefs.theme.dark',
};

export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readStoredTheme);

  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">{t('prefs.theme.label')}</legend>
      {THEME_CHOICES.map((value) => (
        <label key={value} className="theme-switch-option" title={t(LABELS[value])}>
          <input
            type="radio"
            name="theme"
            value={value}
            checked={choice === value}
            onChange={() => {
              setTheme(value);
              setChoice(value);
            }}
          />
          <ThemeIcon choice={value} />
          <span className="visually-hidden">{t(LABELS[value])}</span>
        </label>
      ))}
    </fieldset>
  );
}
