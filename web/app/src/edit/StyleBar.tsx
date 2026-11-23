// The style bar over the paragraph editor (W6.8b slices 1 and 2, design section 6). One row of
// controls: the font picker, size, bold, italic, colour, alignment and line spacing. It edits the
// style the editor holds and never commits by itself: the editor decides when the typing and the
// style go to the engine. The bar is a toolbar with one tab stop at a time
// (roving focus); Left and Right move between its controls, except in the text fields, where they
// move the caret.
import {
  type ChangeEvent,
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
import type { Align } from '../rpc/generated';
import { FONT_ACCEPT } from '../fonts/useFontUpload';
import { FontPicker, type StopProps } from './FontPicker';
import {
  documentNames,
  faceToggle,
  type FontSection,
  pickedStyle,
  selectedOption,
  uploadedFaces,
  type UploadedFace,
} from './fontList';
import { clampRound, LINE_HEIGHT_RANGE, SIZE_RANGE, type TextStyleArg } from './textStyle';

// The Uploaded section's file input: the editor owns the upload (useFontUpload), the bar shows it.
export interface BarUpload {
  // A callback ref: the owner keeps the element for the upload's open().
  readonly setInput: (element: HTMLInputElement | null) => void;
  readonly onOpen: () => void;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export interface StyleBarProps {
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly style: CSSProperties;
  readonly value: TextStyleArg;
  // The picker's sections: the page's document fonts, the standard ones and, with the library, the
  // uploaded ones (fontList.ts).
  readonly fonts: readonly FontSection[];
  // Present when the tab has a font library: the Uploaded section's "Upload font…" row.
  readonly upload?: BarUpload;
  readonly onChange: (next: TextStyleArg) => void;
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
  fonts,
  upload,
  onChange,
  onCommit,
  onEscape,
  onLeave,
}: StyleBarProps) {
  // The control with the tab stop. Only one control is in the tab order at a time.
  const [stop, setStop] = useState(0);
  // The document fonts a Bold or Italic press may switch to (design section 4.1), and the faces of
  // the uploaded families (section 4.3).
  const pageFonts = documentNames(fonts);
  const uploaded = uploadedFaces(fonts);
  // The native colour dialog can take the window's focus while the colour input is open: a blur to
  // no element is not a leave then (design section 6.2, the `picking` flag). The file dialog does
  // the same, so it sets the flag too.
  const picking = useRef(false);
  const openUpload = () => {
    picking.current = true;
    upload?.onOpen();
  };
  // The owner's element binding, plus a native `cancel` listener: a cancelled file dialog fires no
  // change, so the flag is cleared there, or the next blur to nothing is taken for the dialog. React
  // does not wire `cancel` on an input, so the listener is added to the element itself.
  const bindInput = upload?.setInput;
  const bindFile = (element: HTMLInputElement | null) => {
    bindInput?.(element);
    if (element === null) return undefined;
    const cancel = () => {
      picking.current = false;
    };
    element.addEventListener('cancel', cancel);
    return () => {
      element.removeEventListener('cancel', cancel);
      bindInput?.(null);
    };
  };

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
    // Text and number fields keep the arrows for the caret (design section 6.2).
    if (target instanceof HTMLInputElement && (target.type === 'number' || target.type === 'text'))
      return;
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
      <FontPicker
        sections={fonts}
        selected={selectedOption(fonts, value)}
        stop={stopProps(0)}
        onPick={(option) => onChange({ ...value, ...pickedStyle(option, value) })}
        onUpload={upload === undefined ? undefined : openUpload}
      />
      {upload === undefined ? null : (
        <input
          ref={bindFile}
          type="file"
          accept={FONT_ACCEPT}
          hidden
          tabIndex={-1}
          onChange={(event) => {
            picking.current = false;
            upload.onChange(event);
          }}
        />
      )}
      <label className="edit-style-field">
        <span className="visually-hidden">{t('edit.style.size')}</span>
        <NumberField
          value={value.size}
          range={SIZE_RANGE}
          step={0.5}
          stop={stopProps(1)}
          onCommit={(size) => onChange({ ...value, size })}
        />
        <span aria-hidden="true">{t('edit.style.pt')}</span>
      </label>
      <FaceButton
        which="bold"
        value={value}
        pageFonts={pageFonts}
        uploaded={uploaded}
        stop={stopProps(2)}
        onChange={onChange}
      />
      <FaceButton
        which="italic"
        value={value}
        pageFonts={pageFonts}
        uploaded={uploaded}
        stop={stopProps(3)}
        onChange={onChange}
      />
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
          {...stopProps(4)}
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
          {...stopProps(5)}
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
          stop={stopProps(6)}
          onCommit={(line_height) => onChange({ ...value, line_height })}
        />
      </label>
    </div>
  );
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

interface FaceButtonProps {
  readonly which: 'bold' | 'italic';
  readonly value: TextStyleArg;
  readonly pageFonts: readonly string[];
  readonly uploaded: readonly UploadedFace[];
  readonly stop: StopProps;
  readonly onChange: (next: TextStyleArg) => void;
}

// Bold or Italic. A press that the font can't take (a document font with no face of that weight or
// slant on the page, an uploaded family with none) is disabled with the reason as its tooltip; it
// stays focusable so the reason can be read (aria-disabled, not disabled).
function FaceButton({ which, value, pageFonts, uploaded, stop, onChange }: FaceButtonProps) {
  const label = t(which === 'bold' ? 'edit.style.bold' : 'edit.style.italic');
  const change = faceToggle(value, which, pageFonts, uploaded);
  const disabled = change === null;
  const reason = t(which === 'bold' ? 'edit.style.noBold' : 'edit.style.noItalic');
  return (
    <button
      type="button"
      className="edit-style-toggle"
      aria-pressed={which === 'bold' ? value.bold : value.italic}
      aria-disabled={disabled}
      aria-label={label}
      title={disabled ? reason : label}
      {...stop}
      onClick={() => {
        if (change !== null) onChange({ ...value, ...change });
      }}
    >
      <Icon name={which} size={16} />
    </button>
  );
}
