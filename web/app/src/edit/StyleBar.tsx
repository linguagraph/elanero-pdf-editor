// The style bar over the paragraph editor (W6.8b slice 1, design section 6). One row of controls: the
// font's name (read-only until the picker of slice 2), size, bold, italic, colour, alignment and line
// spacing. It edits the style the editor holds and never commits by itself: the editor decides when
// the typing and the style go to the engine. The bar is a toolbar with one tab stop at a time
// (roving focus); Left and Right move between its controls, except in the text fields, where they
// move the caret.
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useRef,
  useState,
} from 'react';
import { t } from '../i18n/t';
import { Icon } from '../theme/Icon';
import { hexToColorJson } from '../prefs/colour';
import { colorInputValue } from '../redaction/MarkStyleFields';
import type { Align, TextStyleDto } from '../rpc/generated';
import { clampRound, LINE_HEIGHT_RANGE, SIZE_RANGE } from './textStyle';

export interface StyleBarProps {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly style: CSSProperties;
  readonly value: TextStyleDto;
  // The font the block uses, shown by name (the picker of slice 2 makes it a control).
  readonly font: string;
  readonly onChange: (next: TextStyleDto) => void;
  // Ctrl+Enter from any control of the bar.
  readonly onCommit: () => void;
  // Escape from the bar: focus goes back to the text, which keeps its selection.
  readonly onEscape: () => void;
  // Focus left the bar for `next` (null when it left the window, or when nothing took it).
  readonly onLeave: (next: EventTarget | null) => void;
}

// The keys that move focus within the bar; the text fields keep them for the caret.
const ROVING_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

export function StyleBar({
  rootRef,
  style,
  value,
  font,
  onChange,
  onCommit,
  onEscape,
  onLeave,
}: StyleBarProps) {
  // The control with the tab stop. Only one control is in the tab order at a time.
  const [stop, setStop] = useState(0);
  // The native colour dialog can take the window's focus while the colour input is open: a blur to
  // no element is not a leave then (design section 6.2, the `picking` flag).
  const picking = useRef(false);

  const stopProps = (index: number): StopProps => ({
    'data-stop': true,
    tabIndex: stop === index ? 0 : -1,
    onFocus: () => setStop(index),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys belong to the bar: the page's shortcuts must not act on the objects.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      onCommit();
      return;
    }
    const root = event.currentTarget;
    const target = event.target;
    if (!ROVING_KEYS.includes(event.key) || !(target instanceof HTMLElement)) return;
    if (target instanceof HTMLSelectElement) return;
    if (target instanceof HTMLInputElement && target.type === 'number') return;
    const stops = Array.from(root.querySelectorAll<HTMLElement>('[data-stop]'));
    const index = stops.indexOf(target);
    if (index < 0) return;
    const last = stops.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (index + 1) % stops.length
            : (index - 1 + stops.length) % stops.length;
    event.preventDefault();
    stops[next]?.focus();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (picking.current && next === null) return;
    picking.current = false;
    onLeave(next);
  };

  // The bar's pointer events stay here; the layer must not start a gesture.
  const stopPointer = (event: PointerEvent<HTMLDivElement>) => event.stopPropagation();

  return (
    <div
      ref={rootRef}
      className="edit-style-bar"
      role="toolbar"
      aria-label={t('edit.style.toolbar')}
      style={style}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onPointerDown={stopPointer}
      onPointerMove={stopPointer}
      onPointerUp={stopPointer}
      onDoubleClick={stopPointer}
    >
      <span className="edit-style-font" title={font}>
        {font}
      </span>
      <label className="edit-style-field">
        <span className="visually-hidden">{t('edit.style.size')}</span>
        <NumberField
          value={value.size}
          range={SIZE_RANGE}
          step={0.5}
          stop={stopProps(0)}
          onCommit={(size) => onChange({ ...value, size })}
        />
        <span aria-hidden="true">{t('edit.style.pt')}</span>
      </label>
      <button
        type="button"
        className="edit-style-toggle"
        aria-pressed={value.bold}
        aria-label={t('edit.style.bold')}
        title={t('edit.style.bold')}
        {...stopProps(1)}
        onClick={() => onChange({ ...value, bold: !value.bold })}
      >
        <Icon name="bold" size={16} />
      </button>
      <button
        type="button"
        className="edit-style-toggle"
        aria-pressed={value.italic}
        aria-label={t('edit.style.italic')}
        title={t('edit.style.italic')}
        {...stopProps(2)}
        onClick={() => onChange({ ...value, italic: !value.italic })}
      >
        <Icon name="italic" size={16} />
      </button>
      <label className="edit-style-colour" title={t('edit.style.colour')}>
        <span className="visually-hidden">{t('edit.style.colour')}</span>
        <span
          className="edit-style-swatch"
          aria-hidden="true"
          style={{ color: colorInputValue(value.color) }}
        >
          A
        </span>
        <input
          type="color"
          value={colorInputValue(value.color)}
          {...stopProps(3)}
          onClick={() => {
            picking.current = true;
          }}
          onChange={(event) => {
            picking.current = false;
            // The colour input has no alpha: the block's own alpha is kept.
            const rgb = hexToColorJson(event.target.value);
            onChange({ ...value, color: { ...rgb, a: value.color.a } });
          }}
        />
      </label>
      <label className="edit-style-field">
        <span className="visually-hidden">{t('edit.style.align')}</span>
        <select
          value={value.align}
          {...stopProps(4)}
          onChange={(event) => onChange({ ...value, align: event.target.value as Align })}
        >
          <option value="left">{t('edit.style.align.left')}</option>
          <option value="center">{t('edit.style.align.center')}</option>
          <option value="right">{t('edit.style.align.right')}</option>
          <option value="justify">{t('edit.style.align.justify')}</option>
        </select>
      </label>
      <label className="edit-style-field">
        <span className="visually-hidden">{t('edit.style.lineSpacing')}</span>
        <NumberField
          value={value.line_height}
          range={LINE_HEIGHT_RANGE}
          step={0.1}
          stop={stopProps(5)}
          onCommit={(line_height) => onChange({ ...value, line_height })}
        />
      </label>
    </div>
  );
}

// The roving-focus props of one control (see StyleBar's stopProps).
interface StopProps {
  readonly 'data-stop': true;
  readonly tabIndex: number;
  readonly onFocus: () => void;
}

interface NumberFieldProps {
  readonly value: number;
  readonly range: { readonly min: number; readonly max: number; readonly digits: number };
  readonly step: number;
  readonly stop: StopProps;
  readonly onCommit: (value: number) => void;
}

// A number field that takes any text while typed and is clamped and rounded when it is left (blur or
// Enter), as the design asks: an out-of-range value is adjusted, not refused.
function NumberField({ value, range, step, stop, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  // The field follows the value from outside (an undo, a change of another control) when it differs
  // from the last one it showed. The recorded value is updated during render, not in an effect.
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
  }

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clampRound(parsed, range);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="number"
      className="edit-style-number"
      min={range.min}
      max={range.max}
      step={step}
      value={draft}
      {...stop}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}
