// The outcome line for each font added (W6.9 slice 4, design section 4.4). A pure mapping, so each
// row of the design's table is a unit test. Refusals and too-large files are 'alert' lines; the
// rest, including a font kept only for this tab, are 'status' lines.
import { formatMegabytes, formatNumber } from '../i18n/format';
import { t, tp } from '../i18n/t';
import { type AddOutcome, MAX_FONT_FILE_BYTES } from './fontLibrary';

export interface UploadMessage {
  readonly tone: 'status' | 'alert';
  readonly text: string;
}

function numberDetail(details: Record<string, unknown>, key: string): number {
  const value = details[key];
  return typeof value === 'number' ? value : 0;
}

function stringDetail(details: Record<string, unknown>, key: string): string {
  const value = details[key];
  return typeof value === 'string' ? value : '';
}

function keptText(reason: 'no-space' | 'unsupported' | 'failed', name: string): string {
  if (reason === 'unsupported') return t('fonts.upload.sessionOnly', { name });
  if (reason === 'no-space') return t('fonts.upload.noSpace', { name });
  return t('fonts.upload.notKept', { name });
}

function refusedText(
  code: string,
  details: Record<string, unknown>,
  name: string,
  usedBytes: number,
): string {
  switch (code) {
    case 'FILE_TOO_LARGE':
      return t('fonts.error.tooLarge', {
        name,
        limit: formatMegabytes(numberDetail(details, 'max_bytes') || MAX_FONT_FILE_BYTES),
      });
    case 'INVALID_FONT': {
      const reason = stringDetail(details, 'reason');
      if (reason === 'woff') return t('fonts.error.woff', { name });
      if (reason === 'no_usable_face') return t('fonts.error.noUsableFace', { name });
      if (reason === 'too_many_faces') return t('fonts.error.tooManyFaces', { name });
      return t('fonts.error.invalid', { name });
    }
    case 'FONT_NOT_EMBEDDABLE':
      return stringDetail(details, 'reason') === 'bitmap_only'
        ? t('fonts.error.bitmapOnly', { name })
        : t('fonts.error.restricted', { name });
    case 'FONT_STORAGE_FULL':
      // The worker's budget: a count limit names the font count, a byte limit the megabytes.
      return stringDetail(details, 'limit') === 'count'
        ? t('fonts.error.fullCount', {
            name,
            max: formatNumber(numberDetail(details, 'max_fonts')),
          })
        : t('fonts.error.fullBytes', {
            name,
            max: formatMegabytes(numberDetail(details, 'max_bytes')),
            used: formatMegabytes(usedBytes),
          });
    case 'NOT_SUPPORTED':
      return t('fonts.error.notSupported');
    default:
      return t('fonts.error.failed', { name });
  }
}

// `usedBytes` is the engine's last reported total: a full-store refusal names it.
export function describeAddOutcome(
  outcome: AddOutcome,
  name: string,
  usedBytes: number,
): UploadMessage {
  switch (outcome.kind) {
    case 'tooLarge':
      return { tone: 'alert', text: refusedText('FILE_TOO_LARGE', {}, name, usedBytes) };
    case 'refused':
      return {
        tone: 'alert',
        text: refusedText(outcome.code, outcome.details, name, usedBytes),
      };
    case 'already':
      return { tone: 'status', text: t('fonts.upload.already', { name }) };
    case 'notKept':
      return { tone: 'status', text: keptText(outcome.reason, name) };
    case 'added': {
      const dto = outcome.font.dto;
      if (dto !== undefined && dto.refused.length > 0) {
        const refused = dto.refused.length;
        const total = dto.faces.length + refused;
        return {
          tone: 'status',
          text: tp('fonts.upload.partial', total, { refused, total, name }),
        };
      }
      if (dto !== undefined && dto.format === 'collection') {
        return {
          tone: 'status',
          text: tp('fonts.upload.addedFaces', dto.faces.length, { name }),
        };
      }
      return { tone: 'status', text: t('fonts.upload.added', { name }) };
    }
  }
}
