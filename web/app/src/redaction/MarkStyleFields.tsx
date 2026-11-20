// The style editor of redaction marks (W7.4b S5): the fill, the text colour and the overlay text.
// The panel uses it for the selection; W4.14 reuses it for the style of new marks. A change is
// sent as a patch with only the field that changed, so a mixed selection is not overwritten in the
// fields the user did not touch. The overlay text is committed on blur or Enter, not on each key.
import { useId, useState } from 'react';
import { t } from '../i18n/t';
import { type ColorJson, hexToColorJson } from '../prefs/colour';
import type { MarkStylePatch } from './marks';
import './redaction.css';

// The longest overlay text the engine takes (open decision 5). It refuses more.
export const OVERLAY_TEXT_LIMIT = 500;

export type MarkStyleField = 'fill' | 'textColor' | 'overlayText';

export interface MarkStyleValues {
  // null is a file with no colour: the engine draws the box black.
  readonly fill: ColorJson | null;
  readonly textColor: ColorJson | null;
  readonly overlayText: string;
}

export interface MarkStyleFieldsProps {
  readonly value: MarkStyleValues;
  // The fields that differ across the selection: shown as "Mixed" and left empty.
  readonly mixed?: Partial<Record<MarkStyleField, boolean>>;
  readonly disabled?: boolean;
  // The longest overlay text the field takes. The panel keeps the engine's limit; the new-mark
  // style dialog passes the preferences' limit, which is shorter (W4.14).
  readonly overlayMaxLength?: number;
  readonly onChange: (patch: MarkStylePatch) => void;
}

const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);

// The colour as the colour input shows it: #rrggbb. Null shows black, as the engine draws it.
export function colorInputValue(color: ColorJson | null): string {
  const c = color ?? { r: 0, g: 0, b: 0 };
  return `#${[c.r, c.g, c.b]
    .map((value) => channel(value).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function MarkStyleFields({
  value,
  mixed = {},
  disabled = false,
  overlayMaxLength = OVERLAY_TEXT_LIMIT,
  onChange,
}: MarkStyleFieldsProps) {
  const overlayId = useId();
  // The overlay text as typed, until it is committed. The panel keys this component on the value,
  // so a change from outside (an undo, another selection) starts from the new text.
  const [draft, setDraft] = useState(value.overlayText);

  const commitOverlay = () => {
    if (draft !== value.overlayText) onChange({ overlayText: draft });
  };

  return (
    <div className="mark-style" role="group" aria-label={t('redactions.properties')}>
      <label className="mark-style-field">
        <span>{t('redactions.fill')}</span>
        <input
          type="color"
          value={colorInputValue(value.fill)}
          disabled={disabled}
          onChange={(event) => onChange({ fill: hexToColorJson(event.target.value) })}
        />
        {mixed.fill ? <span className="mark-style-mixed">{t('redactions.mixed')}</span> : null}
      </label>
      <label className="mark-style-field">
        <span>{t('redactions.textColor')}</span>
        <input
          type="color"
          value={colorInputValue(value.textColor)}
          disabled={disabled}
          onChange={(event) => onChange({ textColor: hexToColorJson(event.target.value) })}
        />
        {mixed.textColor ? <span className="mark-style-mixed">{t('redactions.mixed')}</span> : null}
      </label>
      <label className="mark-style-field" htmlFor={overlayId}>
        <span>{t('redactions.overlayText')}</span>
      </label>
      <input
        id={overlayId}
        type="text"
        className="mark-style-overlay"
        maxLength={overlayMaxLength}
        value={draft}
        placeholder={mixed.overlayText ? t('redactions.mixed') : undefined}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitOverlay}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitOverlay();
        }}
      />
    </div>
  );
}
