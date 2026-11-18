import { useState } from 'react';
import { ThemeIcon } from './icons';
import { readStoredTheme, setTheme, THEME_CHOICES, type ThemeChoice } from './theme';
import './ThemeSwitch.css';

const LABELS: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readStoredTheme);

  return (
    <fieldset className="theme-switch">
      <legend>Theme</legend>
      {THEME_CHOICES.map((value) => (
        <label key={value} className="theme-switch-option">
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
          <span>{LABELS[value]}</span>
        </label>
      ))}
    </fieldset>
  );
}
