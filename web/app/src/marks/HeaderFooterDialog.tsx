// The Header & Footer and Bates Numbers dialog (W7.3, design section 5.3). One form serves both, as
// the desktop's HeaderFooterDialog does: Bates mode pre-fills the footer's right slot with <<bates>>
// and opens the Bates section. The shared shell (MarkDialog) reads the stored marks, runs the
// action and handles Replace, Add New and Remove. The form reads its mode and the file name from
// a context, so the shell's form prop keeps one component type (its state survives re-renders).
import { createContext, Fragment, useContext, useEffect, useId, useMemo, useState } from 'react';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import {
  type BatesForm,
  batesPreview,
  canRunHeaderFooter,
  HEADER_FOOTER_ACTION,
  type HeaderFooterForm,
  type HeaderFooterSlot,
  headerFooterArgs,
  type MarkFont,
  MARK_FONTS,
  MARK_LIMITS,
  type MarkPreFill,
} from './marks';
import { type MarkDialogProps, MarkDialog, type MarkFormProps } from './MarkDialog';

// The text the Bates dialog puts in the footer's right slot on a new mark (desktop pages.py:437).
const BATES_TOKEN = '<<bates>>';

const ROWS = ['header', 'footer'] as const;
const COLUMNS = ['left', 'center', 'right'] as const;
const ROW_LABEL: Readonly<Record<(typeof ROWS)[number], MessageId>> = {
  header: 'marks.hf.header',
  footer: 'marks.hf.footer',
};
const COLUMN_LABEL: Readonly<Record<(typeof COLUMNS)[number], MessageId>> = {
  left: 'marks.hf.left',
  center: 'marks.hf.center',
  right: 'marks.hf.right',
};

export interface HeaderFooterDialogProps extends Omit<
  MarkDialogProps,
  'kind' | 'titleKey' | 'subtitleKey' | 'form'
> {
  // Bates numbers instead of a header and footer: its own kind, so it is updated and removed apart.
  readonly bates: boolean;
  // The document's display name, for the <<file>> token (the desktop passes it too).
  readonly fileName: string;
}

interface ModeOptions {
  readonly bates: boolean;
  readonly fileName: string;
}

const ModeContext = createContext<ModeOptions>({ bates: false, fileName: '' });

export function HeaderFooterDialog({ bates, fileName, ...rest }: HeaderFooterDialogProps) {
  return (
    <ModeContext.Provider value={{ bates, fileName }}>
      <MarkDialog
        {...rest}
        kind={bates ? 'Bates' : 'HeaderFooter'}
        titleKey={bates ? 'marks.bates.title' : 'marks.hf.title'}
        subtitleKey="marks.hf.subtitle"
        form={HeaderFooterFormPart}
      />
    </ModeContext.Provider>
  );
}

// What the fields hold. Numbers stay text until they are read, so an empty field is refused, not 0.
interface Values {
  readonly texts: Partial<Record<HeaderFooterSlot, string>>;
  readonly font: MarkFont;
  readonly fontSize: string;
  readonly color: string;
  readonly marginX: string;
  readonly marginY: string;
  readonly prefix: string;
  readonly start: string;
  readonly digits: string;
  readonly suffix: string;
}

const DEFAULT_COLOR = '#000000';

function numberOf(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function initialValues(pre: MarkPreFill | undefined, bates: boolean): Values {
  const stored = pre?.headerFooter;
  if (stored === undefined) {
    return {
      texts: bates ? { footer_right: BATES_TOKEN } : {},
      font: 'helv',
      fontSize: '9',
      color: DEFAULT_COLOR,
      marginX: '36',
      marginY: '24',
      prefix: '',
      start: '1',
      digits: '6',
      suffix: '',
    };
  }
  return {
    texts: stored.texts,
    font: stored.font,
    fontSize: String(stored.fontSize),
    color: stored.color,
    marginX: String(stored.marginX),
    marginY: String(stored.marginY),
    prefix: stored.bates.prefix,
    start: String(stored.bates.start),
    digits: String(stored.bates.digits),
    suffix: stored.bates.suffix,
  };
}

function formOf(values: Values): HeaderFooterForm {
  const bates: BatesForm = {
    prefix: values.prefix,
    start: numberOf(values.start),
    digits: numberOf(values.digits),
    suffix: values.suffix,
  };
  return {
    texts: values.texts,
    font: values.font,
    fontSize: numberOf(values.fontSize),
    color: values.color,
    marginX: numberOf(values.marginX),
    marginY: numberOf(values.marginY),
    bates,
  };
}

function HeaderFooterFormPart({ pre, pages, onDraft }: MarkFormProps) {
  const { bates, fileName } = useContext(ModeContext);
  const ids = useId();
  const tokensId = `${ids}-tokens`;
  const [values, setValues] = useState<Values>(() => initialValues(pre, bates));
  const form = useMemo(() => formOf(values), [values]);

  const hasText = Object.values(values.texts).some((text) => (text ?? '').trim() !== '');
  const ready = canRunHeaderFooter(form, pages);
  const reason: MessageId | null = ready
    ? null
    : pages.length === 0
      ? 'marks.reason.noPages'
      : !hasText
        ? 'marks.reason.noText'
        : 'marks.reason.value';

  useEffect(() => {
    onDraft({
      action: HEADER_FOOTER_ACTION,
      ready,
      reason,
      args: (target, replace) => headerFooterArgs(form, target, fileName, bates, replace),
    });
    return () => onDraft(null);
  }, [onDraft, ready, reason, form, fileName, bates]);

  const setText = (slot: HeaderFooterSlot, text: string) =>
    setValues((previous) => ({ ...previous, texts: { ...previous.texts, [slot]: text } }));
  const set = <K extends Exclude<keyof Values, 'texts'>>(key: K, value: Values[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  const preview = batesPreview(form.bates);

  return (
    <div className="mark-form-part">
      <div className="mark-grid">
        <span aria-hidden="true" />
        {COLUMNS.map((column) => (
          <span key={column} className="mark-grid-head" aria-hidden="true">
            {t(COLUMN_LABEL[column])}
          </span>
        ))}
        {ROWS.map((row) => (
          <Fragment key={row}>
            <span className="mark-grid-head" aria-hidden="true">
              {t(ROW_LABEL[row])}
            </span>
            {COLUMNS.map((column) => {
              const slot = `${row}_${column}` as HeaderFooterSlot;
              return (
                <input
                  key={slot}
                  type="text"
                  className="mark-slot"
                  aria-label={t('marks.hf.slot', {
                    row: t(ROW_LABEL[row]),
                    column: t(COLUMN_LABEL[column]),
                  })}
                  aria-describedby={tokensId}
                  value={values.texts[slot] ?? ''}
                  onChange={(event) => setText(slot, event.target.value)}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <p id={tokensId} className="mark-note">
        {t('marks.hf.tokens')}
      </p>
      <details className="mark-details">
        <summary>{t('marks.hf.style')}</summary>
        <div className="mark-fields">
          <label className="mark-field">
            <span>{t('marks.font')}</span>
            <select
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
          <Field
            label={t('marks.fontSize')}
            value={values.fontSize}
            onChange={(v) => set('fontSize', v)}
            type="number"
            min={MARK_LIMITS.fontSize.min}
            max={MARK_LIMITS.fontSize.max}
          />
          <Field
            label={t('marks.color')}
            value={values.color}
            onChange={(v) => set('color', v)}
            type="color"
          />
          <Field
            label={t('marks.hf.marginX')}
            value={values.marginX}
            onChange={(v) => set('marginX', v)}
            type="number"
            min={MARK_LIMITS.margin.min}
            max={MARK_LIMITS.margin.max}
          />
          <Field
            label={t('marks.hf.marginY')}
            value={values.marginY}
            onChange={(v) => set('marginY', v)}
            type="number"
            min={MARK_LIMITS.margin.min}
            max={MARK_LIMITS.margin.max}
          />
        </div>
      </details>
      <details className="mark-details" open={bates}>
        <summary>{t('marks.bates.section')}</summary>
        <div className="mark-fields">
          <Field
            label={t('marks.bates.prefix')}
            value={values.prefix}
            onChange={(v) => set('prefix', v)}
          />
          <Field
            label={t('marks.bates.start')}
            value={values.start}
            onChange={(v) => set('start', v)}
            type="number"
            min={MARK_LIMITS.batesStart.min}
            max={MARK_LIMITS.batesStart.max}
          />
          <Field
            label={t('marks.bates.digits')}
            value={values.digits}
            onChange={(v) => set('digits', v)}
            type="number"
            min={MARK_LIMITS.batesDigits.min}
            max={MARK_LIMITS.batesDigits.max}
          />
          <Field
            label={t('marks.bates.suffix')}
            value={values.suffix}
            onChange={(v) => set('suffix', v)}
          />
          {preview === undefined ? null : (
            <p className="mark-note">{t('marks.bates.preview', { value: preview })}</p>
          )}
        </div>
      </details>
    </div>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'number' | 'color';
  readonly min?: number;
  readonly max?: number;
}

// One labelled field of the form. The label wraps the control, so its name is the label text.
function Field({ label, value, onChange, type = 'text', min, max }: FieldProps) {
  return (
    <label className="mark-field">
      <span>{label}</span>
      <input
        type={type}
        inputMode={type === 'number' ? 'decimal' : undefined}
        min={min}
        max={max}
        step={type === 'number' ? 1 : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
