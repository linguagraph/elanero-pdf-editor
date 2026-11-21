// The compress flow (W6.4, R5): the reduce_size job run through the shared file job flow
// (src/files/fileJob.ts). The job is read-only: it writes a smaller copy and reports the sizes, and
// the document stays as it is. Its one file is reduced.pdf; the dialog decides whether to offer it.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJobOutput } from '../files/fileJob';
import {
  REDUCE_DPI_RANGE,
  REDUCE_PRESETS,
  REDUCE_QUALITY_RANGE,
  SPACE_CATEGORY_KEYS,
  type SpaceCategoryKey,
} from '../rpc/generated';
import { expectArray, expectInteger, expectObject, expectOneOf, field, orNull } from '../rpc/shape';

// The presets, by the keys the reduce_size job takes (ReduceSizeArgs in webapi/dto.py). The order is
// the dialog's order: the smallest file first.
export const COMPRESS_PRESETS = ['screen', 'ebook', 'print', 'lossless'] as const;
export type CompressPreset = (typeof COMPRESS_PRESETS)[number];

// The desktop dialog's fields (ReduceOptionsDto): the custom preset sends them, and a named preset
// is seeded from them (REDUCE_PRESETS, generated from services.optimize.PRESETS).
export interface ReduceOptions {
  readonly image_dpi: number | null; // null keeps the image resolution
  readonly jpeg_quality: number;
  readonly grayscale: boolean;
  readonly subset_fonts: boolean;
  readonly remove_thumbnails: boolean;
  readonly remove_metadata: boolean;
  readonly object_streams: boolean;
}

// What the dialog is set to: a named preset (its options are the preset's seed) or a custom one.
export interface CompressSettings {
  readonly preset: CompressPreset | 'custom';
  readonly options: ReduceOptions;
}

// The image resolution is either null (keep it) or a whole number of dpi in range.
export function dpiIsValid(dpi: number | null): boolean {
  return (
    dpi === null ||
    (Number.isInteger(dpi) && dpi >= REDUCE_DPI_RANGE[0] && dpi <= REDUCE_DPI_RANGE[1])
  );
}

export function qualityIsValid(quality: number): boolean {
  return (
    Number.isInteger(quality) &&
    quality >= REDUCE_QUALITY_RANGE[0] &&
    quality <= REDUCE_QUALITY_RANGE[1]
  );
}

// Whether the settings can be sent: the job refuses an out-of-range value, so the dialog never sends one.
export function optionsAreValid(options: ReduceOptions): boolean {
  return dpiIsValid(options.image_dpi) && qualityIsValid(options.jpeg_quality);
}

// The space audit (SpaceAuditTable reads it): the stored bytes of the whole document and of each
// category, by the stable key for t(). The engine's English name is not read.
export interface SpaceAudit {
  readonly total: number;
  readonly categories: readonly { readonly key: SpaceCategoryKey; readonly size: number }[];
}

export type CompressDeps = FileJobDeps;

// The outcome: the sizes in bytes, the copy the job wrote, and the audits (null unless asked for).
// The copy is present even when it is not smaller; the dialog offers it only when it is.
export interface CompressResult {
  readonly before: number;
  readonly after: number;
  readonly file: ResultFile | undefined;
  readonly auditBefore: SpaceAudit | null;
  readonly auditAfter: SpaceAudit | null;
}

// The settings a named preset starts from. A copy, so a field edit never changes the preset table.
export function presetSettings(preset: CompressPreset): CompressSettings {
  return { preset, options: { ...REDUCE_PRESETS[preset] } };
}

// Whether two settings give the same job: the dialog flips to Custom when the fields stop matching.
export function sameSettings(a: CompressSettings, b: CompressSettings): boolean {
  return (
    a.preset === b.preset &&
    a.options.image_dpi === b.options.image_dpi &&
    a.options.jpeg_quality === b.options.jpeg_quality &&
    a.options.grayscale === b.options.grayscale &&
    a.options.subset_fonts === b.options.subset_fonts &&
    a.options.remove_thumbnails === b.options.remove_thumbnails &&
    a.options.remove_metadata === b.options.remove_metadata &&
    a.options.object_streams === b.options.object_streams
  );
}

// The reduce_size arguments. A named preset sends only its key (the job refuses options with one);
// a custom preset sends the options with the key "custom".
export function reduceArgs(settings: CompressSettings, audit: boolean): Record<string, unknown> {
  if (settings.preset !== 'custom') return { preset: settings.preset, audit };
  return { preset: 'custom', options: { ...settings.options }, audit };
}

// Reads a SpaceAudit reply (SpaceAuditTable's source); null passes through (no audit asked for).
// Only the key and the size are read: the engine's English name is for the desktop and the logs.
export function readAudit(value: unknown, path: string): SpaceAudit | null {
  return orNull(value, path, (raw, rawPath) => {
    const audit = expectObject(raw, rawPath);
    const categories = expectArray(field(audit, 'categories', rawPath), `${rawPath}.categories`);
    return {
      total: expectInteger(field(audit, 'total', rawPath), `${rawPath}.total`),
      categories: categories.map((item, index) => {
        const path = `${rawPath}.categories[${index}]`;
        const category = expectObject(item, path);
        return {
          key: expectOneOf(field(category, 'key', path), SPACE_CATEGORY_KEYS, `${path}.key`),
          size: expectInteger(field(category, 'size', path), `${path}.size`),
        };
      }),
    };
  });
}

// Runs one compress with the settings. Resolves with the sizes, the copy and the audits; rejects
// with an RpcError, or FileJobCancelled (the file job's cancel).
export async function runCompress(
  deps: CompressDeps,
  handle: string,
  settings: CompressSettings,
  { audit }: { readonly audit: boolean },
): Promise<CompressResult> {
  const output = await runFileJobOutput(deps, handle, 'reduce_size', reduceArgs(settings, audit));
  // The job's value is ReduceSizeValue: before, after and the notes. The notes are the engine's own
  // English text, so the dialog does not show them; it says what it knows through t() instead.
  const value = expectObject(output.value, 'result.value');
  return {
    before: expectInteger(field(value, 'before', 'result.value'), 'result.value.before'),
    after: expectInteger(field(value, 'after', 'result.value'), 'result.value.after'),
    file: output.files[0],
    auditBefore: readAudit(
      field(value, 'audit_before', 'result.value'),
      'result.value.audit_before',
    ),
    auditAfter: readAudit(field(value, 'audit_after', 'result.value'), 'result.value.audit_after'),
  };
}

// One row of the space table: a part's stored bytes before and after the run.
export interface AuditRow {
  readonly key: SpaceCategoryKey;
  readonly before: number;
  readonly after: number;
}

// The table's rows from the two audits (both present, or no rows). A part is summed by key, since
// two engine labels can both map to "other"; a part that is zero in both is left out. The rows are
// the largest first, ties in SPACE_CATEGORY_KEYS order, and file overhead is always last: it is
// what the parts do not account for, so it reads as the remainder. No total row: the headline has
// the true sizes, and an audit total can differ from them (the design, section 2).
export function auditRows(before: SpaceAudit | null, after: SpaceAudit | null): AuditRow[] {
  if (before === null || after === null) return [];
  const sums = new Map<SpaceCategoryKey, { before: number; after: number }>();
  const add = (audit: SpaceAudit, side: 'before' | 'after') => {
    for (const { key, size } of audit.categories) {
      const sum = sums.get(key) ?? { before: 0, after: 0 };
      sum[side] += size;
      sums.set(key, sum);
    }
  };
  add(before, 'before');
  add(after, 'after');
  const order = (key: SpaceCategoryKey) => SPACE_CATEGORY_KEYS.indexOf(key);
  return [...sums]
    .filter(([, sum]) => sum.before !== 0 || sum.after !== 0)
    .map(([key, sum]) => ({ key, before: sum.before, after: sum.after }))
    .sort((a, b) => {
      if (a.key === 'file_overhead' || b.key === 'file_overhead') {
        return Number(a.key === 'file_overhead') - Number(b.key === 'file_overhead');
      }
      return b.before - a.before || order(a.key) - order(b.key);
    });
}

// The share of the original that is saved, in whole percent (0 when the copy is not smaller).
export function savedPercent(before: number, after: number): number {
  if (before <= 0 || after >= before) return 0;
  return Math.round(((before - after) / before) * 100);
}

// Whether the copy is smaller than the original. The dialog offers a download only then.
export function isSmaller(before: number, after: number): boolean {
  return after < before;
}
