// Shape Style (W6.7b slice 3a): the outline, fill and line width of the shapes drawn next, for all
// three shape tools. Like Redaction Properties it changes no document: a shape takes the style when
// it is drawn, and shapes already on the page keep theirs. Nothing is stored between sessions.
import { type KeyboardEvent, useId, useState } from 'react';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { type ColorJson, hexToColorJson } from '../prefs/colour';
import { colorInputValue } from '../redaction/MarkStyleFields';
import {
  currentShapeStyle,
  MAX_SHAPE_WIDTH,
  parseShapeWidth,
  setShapeStyle,
  type ShapeStyle,
} from './shapeStyle';
import '../prefs/preferences.css';
import './edit.css';

export interface ShapeStyleDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShapeStyleDialog({ isOpen, onClose }: ShapeStyleDialogProps) {
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onClose}
      title={t('edit.shapeStyle.title')}
      showCloseButton={false}
    >
      <ShapeStyleForm onDone={onClose} />
    </Overlay>
  );
}

// Mounted only while the dialog is open, so every open starts from the style in use. The form is
// not a <form>: OK is an explicit action, and Enter in the width field is the same as OK.
function ShapeStyleForm({ onDone }: { readonly onDone: () => void }) {
  const ids = {
    outline: useId(),
    fill: useId(),
    fillColour: useId(),
    width: useId(),
    error: useId(),
  };
  const [initial] = useState<ShapeStyle>(currentShapeStyle);
  const [outline, setOutline] = useState<ColorJson>(initial.outline);
  const [filled, setFilled] = useState(initial.fill !== null);
  // A fill starts white when the box is first ticked; the last colour is kept while it is off.
  const [fillColour, setFillColour] = useState<ColorJson>(initial.fill ?? { r: 1, g: 1, b: 1 });
  const [widthText, setWidthText] = useState(String(initial.width));
  const width = parseShapeWidth(widthText);

  const apply = () => {
    if (width === null) return;
    setShapeStyle({ outline, fill: filled ? fillColour : null, width });
    onDone();
  };

  const onWidthKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply();
    }
  };

  return (
    <div className="shape-style">
      <span className="prefs-hint">{t('edit.shapeStyle.intro')}</span>
      <div className="shape-style-form">
        <label className="shape-style-field" htmlFor={ids.outline}>
          <span>{t('edit.shapeStyle.outline')}</span>
        </label>
        <input
          id={ids.outline}
          type="color"
          value={colorInputValue(outline)}
          onChange={(event) => setOutline(hexToColorJson(event.target.value))}
        />

        <label className="shape-style-field" htmlFor={ids.fill}>
          <input
            id={ids.fill}
            type="checkbox"
            checked={filled}
            onChange={(event) => setFilled(event.target.checked)}
          />
          <span>{t('edit.shapeStyle.fill')}</span>
        </label>
        <input
          id={ids.fillColour}
          type="color"
          aria-label={t('edit.shapeStyle.fillColour')}
          value={colorInputValue(fillColour)}
          disabled={!filled}
          onChange={(event) => setFillColour(hexToColorJson(event.target.value))}
        />
        <span className="prefs-hint shape-style-note">{t('edit.shapeStyle.lineNoFill')}</span>

        <label className="shape-style-field" htmlFor={ids.width}>
          <span>{t('edit.shapeStyle.width')}</span>
        </label>
        <input
          id={ids.width}
          type="number"
          min="0.25"
          max={MAX_SHAPE_WIDTH}
          step="0.25"
          value={widthText}
          aria-invalid={width === null}
          aria-describedby={width === null ? ids.error : undefined}
          onChange={(event) => setWidthText(event.target.value)}
          onKeyDown={onWidthKey}
        />
        {width === null ? (
          <span id={ids.error} className="prefs-error shape-style-note" role="alert">
            {t('edit.shapeStyle.widthInvalid')}
          </span>
        ) : null}
      </div>

      <span className="prefs-hint">{t('edit.shapeStyle.preview')}</span>
      <svg
        className="shape-style-preview"
        viewBox="0 0 120 60"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="10"
          y="10"
          width="100"
          height="40"
          stroke={colorInputValue(outline)}
          strokeWidth={Math.min(width ?? initial.width, 12)}
          fill={filled ? colorInputValue(fillColour) : 'none'}
        />
      </svg>

      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onDone}>
          {t('edit.shapeStyle.cancel')}
        </button>
        <button
          type="button"
          className="overlay-close prefs-apply"
          disabled={width === null}
          onClick={apply}
        >
          {t('edit.shapeStyle.ok')}
        </button>
      </div>
    </div>
  );
}
