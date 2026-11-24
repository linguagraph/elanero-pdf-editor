// The watermark dialog (W7.3, design section 5.4). This slice is the text mode: the text is
// stamped across the chosen pages, with its font, size, colour, opacity and angle. The shared shell
// (MarkDialog) reads the stored watermark when the document has one, runs the action and handles
// Replace, Add New and Remove. The image mode follows in its own slice.
import { useEffect, useId, useMemo, useState } from 'react';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import {
  canRunWatermark,
  MARK_FONTS,
  MARK_LIMITS,
  type MarkFont,
  type MarkPreFill,
  WATERMARK_ACTION,
  type WatermarkForm,
  watermarkArgs,
} from './marks';
import { type MarkDialogProps, MarkDialog, type MarkFormProps } from './MarkDialog';

// The desktop's defaults (ui/dialogs/pages.py WatermarkDialog): Helvetica, 60 pt, a dark red
// (0.75, 0.1, 0.1), 30 % opacity, 45 degrees, drawn over the page content.
const DEFAULT_TEXT = 'CONFIDENTIAL';
const DEFAULT_COLOR = '#bf1a1a';
const DEFAULT_FONT_SIZE = 60;
const DEFAULT_OPACITY_PERCENT = 30;
const DEFAULT_ANGLE = 45;

export type WatermarkDialogProps = Omit<
  MarkDialogProps,
  'kind' | 'titleKey' | 'subtitleKey' | 'form'
>;

export function WatermarkDialog(props: WatermarkDialogProps) {
  return (
    <MarkDialog
      {...props}
      kind="Watermark"
      titleKey="marks.wm.title"
      subtitleKey="marks.wm.subtitle"
      form={WatermarkFormPart}
    />
  );
}

// What the fields hold. Numbers stay text until they are read, so an empty field is refused, not 0.
interface Values {
  readonly text: string;
  readonly font: MarkFont;
  readonly fontSize: string;
  readonly color: string;
  readonly opacityPercent: string;
  readonly angle: string;
  readonly behind: boolean;
}

function numberOf(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function initialValues(pre: MarkPreFill | undefined): Values {
  const stored = pre?.watermark?.form;
  if (stored === undefined) {
    return {
      text: DEFAULT_TEXT,
      font: 'helv',
      fontSize: String(DEFAULT_FONT_SIZE),
      color: DEFAULT_COLOR,
      opacityPercent: String(DEFAULT_OPACITY_PERCENT),
      angle: String(DEFAULT_ANGLE),
      behind: false,
    };
  }
  return {
    text: stored.text,
    font: stored.font,
    fontSize: String(stored.fontSize),
    color: stored.color,
    // The field holds percent, as the desktop shows it; the engine takes a fraction.
    opacityPercent: String(Math.round(stored.opacity * 100)),
    angle: String(stored.angle),
    behind: !stored.onTop,
  };
}

function formOf(values: Values): WatermarkForm {
  return {
    text: values.text,
    font: values.font,
    fontSize: numberOf(values.fontSize),
    color: values.color,
    opacity: numberOf(values.opacityPercent) / 100,
    angle: numberOf(values.angle),
    onTop: !values.behind,
  };
}

function reasonOf(form: WatermarkForm, pages: readonly number[]): MessageId | null {
  if (canRunWatermark(form, pages)) return null;
  if (pages.length === 0) return 'marks.reason.noPages';
  if (form.text.trim() === '') return 'marks.wm.textRequired';
  return 'marks.reason.value';
}

function WatermarkFormPart({ pre, pages, onDraft }: MarkFormProps) {
  const ids = useId();
  const [values, setValues] = useState<Values>(() => initialValues(pre));
  const form = useMemo(() => formOf(values), [values]);

  const ready = canRunWatermark(form, pages);
  const reason = reasonOf(form, pages);

  useEffect(() => {
    onDraft({
      action: WATERMARK_ACTION,
      ready,
      reason,
      args: (target, replace) => watermarkArgs(form, target, replace),
    });
    return () => onDraft(null);
  }, [onDraft, ready, reason, form]);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  return (
    <div className="mark-form-part">
      <div className="mark-fields">
        <label className="mark-field" htmlFor={`${ids}-text`}>
          <span>{t('marks.wm.text')}</span>
          <input
            id={`${ids}-text`}
            type="text"
            value={values.text}
            onChange={(event) => set('text', event.target.value)}
          />
        </label>
        <label className="mark-field" htmlFor={`${ids}-font`}>
          <span>{t('marks.font')}</span>
          <select
            id={`${ids}-font`}
            value={values.font}
            onChange={(event) => set('font', event.target.value as MarkFont)}
          >
            {MARK_FONTS.map((font) => (
              <option key={font.value} value={font.value}>
                {t(font.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="mark-field" htmlFor={`${ids}-size`}>
          <span>{t('marks.fontSize')}</span>
          <input
            id={`${ids}-size`}
            type="number"
            inputMode="decimal"
            min={MARK_LIMITS.watermarkSize.min}
            max={MARK_LIMITS.watermarkSize.max}
            step={1}
            value={values.fontSize}
            onChange={(event) => set('fontSize', event.target.value)}
          />
        </label>
        <label className="mark-field" htmlFor={`${ids}-color`}>
          <span>{t('marks.color')}</span>
          <input
            id={`${ids}-color`}
            type="color"
            value={values.color}
            onChange={(event) => set('color', event.target.value)}
          />
        </label>
        <label className="mark-field" htmlFor={`${ids}-opacity`}>
          <span>{t('marks.opacity')}</span>
          <span className="mark-suffixed">
            <input
              id={`${ids}-opacity`}
              type="number"
              inputMode="numeric"
              min={MARK_LIMITS.opacity.min * 100}
              max={MARK_LIMITS.opacity.max * 100}
              step={1}
              value={values.opacityPercent}
              onChange={(event) => set('opacityPercent', event.target.value)}
            />
            <span>%</span>
          </span>
        </label>
        <label className="mark-field" htmlFor={`${ids}-angle`}>
          <span>{t('marks.wm.angle')}</span>
          <input
            id={`${ids}-angle`}
            type="number"
            inputMode="decimal"
            min={MARK_LIMITS.angle.min}
            max={MARK_LIMITS.angle.max}
            step={1}
            value={values.angle}
            onChange={(event) => set('angle', event.target.value)}
          />
        </label>
        <label className="mark-scope-option">
          <input
            type="checkbox"
            checked={values.behind}
            onChange={(event) => set('behind', event.target.checked)}
          />
          {t('marks.wm.behind')}
        </label>
      </div>
    </div>
  );
}
