// The watermark dialog (W7.3, design section 5.4). A text watermark, or a picture (PNG or JPEG) that
// is stamped across the chosen pages with its font, size, colour and opacity, and for text its
// angle and for a picture its width. The shared shell (MarkDialog) reads the stored watermark when
// the document has one, runs the action and handles Replace, Add New and Remove. A stored picture
// is not kept, so an Update asks for the picture again (W7.3 question 4).
import { type ChangeEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import {
  canRunWatermark,
  isPictureFile,
  MARK_FONTS,
  MARK_LIMITS,
  type MarkFont,
  type MarkPreFill,
  PICTURE_TYPES,
  WATERMARK_ACTION,
  type WatermarkForm,
  type WatermarkPicture,
  watermarkArgs,
} from './marks';
import { type MarkDialogProps, MarkDialog, type MarkFormProps } from './MarkDialog';

// The desktop's defaults (ui/dialogs/pages.py WatermarkDialog): Helvetica, 60 pt, a dark red
// (0.75, 0.1, 0.1), 30 % opacity, 45 degrees, drawn over the page content. A picture is half the
// page width.
const DEFAULT_TEXT = 'CONFIDENTIAL';
const DEFAULT_COLOR = '#bf1a1a';
const DEFAULT_FONT_SIZE = 60;
const DEFAULT_OPACITY_PERCENT = 30;
const DEFAULT_ANGLE = 45;
const DEFAULT_SCALE_PERCENT = 50;

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
  readonly image: boolean;
  readonly text: string;
  readonly font: MarkFont;
  readonly fontSize: string;
  readonly color: string;
  readonly opacityPercent: string;
  readonly angle: string;
  readonly scalePercent: string;
  readonly behind: boolean;
}

function numberOf(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function initialValues(pre: MarkPreFill | undefined): Values {
  const stored = pre?.watermark?.form;
  if (stored === undefined) {
    return {
      image: false,
      text: DEFAULT_TEXT,
      font: 'helv',
      fontSize: String(DEFAULT_FONT_SIZE),
      color: DEFAULT_COLOR,
      opacityPercent: String(DEFAULT_OPACITY_PERCENT),
      angle: String(DEFAULT_ANGLE),
      scalePercent: String(DEFAULT_SCALE_PERCENT),
      behind: false,
    };
  }
  return {
    image: stored.image,
    text: stored.text,
    font: stored.font,
    fontSize: String(stored.fontSize),
    color: stored.color,
    // The field holds percent, as the desktop shows it; the engine takes a fraction.
    opacityPercent: String(Math.round(stored.opacity * 100)),
    angle: String(stored.angle),
    scalePercent: String(Math.round(stored.scale * 100)),
    behind: !stored.onTop,
  };
}

function formOf(values: Values): WatermarkForm {
  return {
    image: values.image,
    text: values.text,
    font: values.font,
    fontSize: numberOf(values.fontSize),
    color: values.color,
    opacity: numberOf(values.opacityPercent) / 100,
    angle: numberOf(values.angle),
    scale: numberOf(values.scalePercent) / 100,
    onTop: !values.behind,
  };
}

function reasonOf(
  form: WatermarkForm,
  pages: readonly number[],
  picked: boolean,
): MessageId | null {
  if (canRunWatermark(form, pages, picked)) return null;
  if (pages.length === 0) return 'marks.reason.noPages';
  if (form.image && !picked) return 'marks.wm.imageRequired';
  if (!form.image && form.text.trim() === '') return 'marks.wm.textRequired';
  return 'marks.reason.value';
}

function WatermarkFormPart({ pre, pages, onDraft }: MarkFormProps) {
  const ids = useId();
  const [values, setValues] = useState<Values>(() => initialValues(pre));
  const [picture, setPicture] = useState<WatermarkPicture | null>(null);
  const [pictureRefused, setPictureRefused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const form = useMemo(() => formOf(values), [values]);
  const picked = picture !== null;

  const ready = canRunWatermark(form, pages, picked);
  const reason = reasonOf(form, pages, picked);

  useEffect(() => {
    // The picture is a job buffer only in picture mode, as the arguments name it only then.
    const usesPicture = form.image && picture !== null;
    onDraft({
      action: WATERMARK_ACTION,
      ready,
      reason,
      args: (target, replace) => watermarkArgs(form, target, replace, picture),
      buffers: usesPicture ? [picture.bytes] : [],
    });
    return () => onDraft(null);
  }, [onDraft, ready, reason, form, picture]);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  // Reads the chosen file. A file of another type or size is refused, and the picture cleared, so
  // Apply cannot run with a picture the user did not see accepted. The engine checks the pixels.
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared, so that choosing the same file again still raises a change.
    event.target.value = '';
    if (file === undefined) return;
    const refuse = () => {
      setPicture(null);
      setPictureRefused(true);
    };
    if (!isPictureFile(file)) {
      refuse();
      return;
    }
    setPictureRefused(false);
    file.arrayBuffer().then((bytes) => setPicture({ name: file.name, bytes }), refuse);
  };

  const storedName = pre?.watermark?.image ? pre.watermark.imageName : undefined;

  return (
    <div className="mark-form-part">
      <fieldset className="mark-scope">
        <legend>{t('marks.wm.kind')}</legend>
        <label className="mark-scope-option">
          <input
            type="radio"
            name={`${ids}-kind`}
            checked={!values.image}
            onChange={() => set('image', false)}
          />
          {t('marks.wm.useText')}
        </label>
        <label className="mark-scope-option">
          <input
            type="radio"
            name={`${ids}-kind`}
            checked={values.image}
            onChange={() => set('image', true)}
          />
          {t('marks.wm.useImage')}
        </label>
      </fieldset>
      <div className="mark-fields">
        {values.image ? (
          <div className="mark-field">
            <span>{t('marks.wm.picture')}</span>
            <span className="mark-picture">
              <button type="button" onClick={() => fileInput.current?.click()}>
                {t('marks.wm.chooseImage')}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept={PICTURE_TYPES.join(',')}
                hidden
                onChange={chooseFile}
              />
              {picture !== null ? <span>{picture.name}</span> : null}
            </span>
            {storedName !== undefined && picture === null ? (
              <span className="mark-note">{t('marks.wm.imageAgain', { name: storedName })}</span>
            ) : null}
            {pictureRefused ? <span role="alert">{t('marks.wm.imageInvalid')}</span> : null}
          </div>
        ) : (
          <label className="mark-field" htmlFor={`${ids}-text`}>
            <span>{t('marks.wm.text')}</span>
            <input
              id={`${ids}-text`}
              type="text"
              value={values.text}
              onChange={(event) => set('text', event.target.value)}
            />
          </label>
        )}
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
            disabled={values.image}
            value={values.angle}
            onChange={(event) => set('angle', event.target.value)}
          />
        </label>
        <label className="mark-field" htmlFor={`${ids}-scale`}>
          <span>{t('marks.wm.scale')}</span>
          <span className="mark-suffixed">
            <input
              id={`${ids}-scale`}
              type="number"
              inputMode="numeric"
              min={MARK_LIMITS.imageScale.min * 100}
              max={MARK_LIMITS.imageScale.max * 100}
              step={1}
              disabled={!values.image}
              value={values.scalePercent}
              onChange={(event) => set('scalePercent', event.target.value)}
            />
            <span>%</span>
          </span>
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
