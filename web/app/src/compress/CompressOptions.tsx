// The custom compress fields (W6.4 S3): the desktop dialog's image and "Fonts and structure"
// options (ui/dialogs/optimize.py). They are seeded from the chosen preset; any edit makes the
// settings Custom, as on the desktop. The limits come from the generated ranges (webapi.jobs), so
// the fields and the job agree.
import { useId } from 'react';
import { t } from '../i18n/t';
import { REDUCE_DPI_RANGE, REDUCE_QUALITY_RANGE } from '../rpc/generated';
import { dpiIsValid, qualityIsValid, type ReduceOptions } from './compressJob';

// The dpi shown in the field when Keep is off. A cleared field is NaN, which shows as empty.
const DPI_RESTORE = 300; // the desktop's default when "keep" is switched off

function fieldNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function shownNumber(value: number | null): string {
  return value === null || Number.isNaN(value) ? '' : String(value);
}

type FlagKey =
  'grayscale' | 'subset_fonts' | 'remove_thumbnails' | 'remove_metadata' | 'object_streams';

export interface CompressOptionsProps {
  readonly options: ReduceOptions;
  readonly disabled: boolean;
  readonly onChange: (options: ReduceOptions) => void;
}

export function CompressOptions({ options, disabled, onChange }: CompressOptionsProps) {
  const ids = useId();
  const keep = options.image_dpi === null;
  const dpiError = !keep && !dpiIsValid(options.image_dpi);
  const qualityError = !qualityIsValid(options.jpeg_quality);
  const dpiId = `${ids}-dpi-error`;
  const qualityId = `${ids}-quality-error`;

  const set = <K extends keyof ReduceOptions>(key: K, value: ReduceOptions[K]) =>
    onChange({ ...options, [key]: value });
  const flag = (key: FlagKey, label: string) => (
    <label className="compress-check">
      <input
        type="checkbox"
        checked={options[key]}
        disabled={disabled}
        onChange={(event) => set(key, event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="compress-fields">
      <fieldset className="compress-images" disabled={disabled}>
        <legend className="compress-label">{t('compress.images.label')}</legend>
        <label className="compress-check">
          <input
            type="checkbox"
            checked={keep}
            onChange={(event) => set('image_dpi', event.target.checked ? null : DPI_RESTORE)}
          />
          <span>{t('compress.field.keep')}</span>
        </label>
        <label className="compress-field">
          <span>{t('compress.field.dpi')}</span>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={REDUCE_DPI_RANGE[0]}
            max={REDUCE_DPI_RANGE[1]}
            value={shownNumber(options.image_dpi)}
            disabled={disabled || keep}
            aria-invalid={dpiError}
            aria-describedby={dpiError ? dpiId : undefined}
            onChange={(event) => set('image_dpi', fieldNumber(event.target.value))}
          />
        </label>
        {dpiError ? (
          <p id={dpiId} className="compress-error" role="alert">
            {t('compress.error.dpi', { min: REDUCE_DPI_RANGE[0], max: REDUCE_DPI_RANGE[1] })}
          </p>
        ) : null}
        <label className="compress-field">
          <span>{t('compress.field.quality')}</span>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={REDUCE_QUALITY_RANGE[0]}
            max={REDUCE_QUALITY_RANGE[1]}
            value={shownNumber(options.jpeg_quality)}
            disabled={disabled}
            aria-invalid={qualityError}
            aria-describedby={qualityError ? qualityId : undefined}
            onChange={(event) => set('jpeg_quality', fieldNumber(event.target.value))}
          />
        </label>
        {qualityError ? (
          <p id={qualityId} className="compress-error" role="alert">
            {t('compress.error.quality', {
              min: REDUCE_QUALITY_RANGE[0],
              max: REDUCE_QUALITY_RANGE[1],
            })}
          </p>
        ) : null}
        {flag('grayscale', t('compress.field.grayscale'))}
      </fieldset>
      <details className="compress-advanced">
        <summary>{t('compress.advanced.label')}</summary>
        {flag('subset_fonts', t('compress.field.subset'))}
        {flag('remove_thumbnails', t('compress.field.thumbnails'))}
        {flag('remove_metadata', t('compress.field.metadata'))}
        {flag('object_streams', t('compress.field.objectStreams'))}
      </details>
    </div>
  );
}
