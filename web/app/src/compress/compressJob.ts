// The compress flow (W6.4, R5): the reduce_size job run through the shared file job flow
// (src/files/fileJob.ts). The job is read-only: it writes a smaller copy and reports the sizes, and
// the document stays as it is. Its one file is reduced.pdf; the dialog decides whether to offer it.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJobOutput } from '../files/fileJob';
import { expectInteger, expectObject, field } from '../rpc/shape';

// The presets, by the keys the reduce_size job takes (ReduceSizeArgs in webapi/dto.py). The order is
// the dialog's order: the smallest file first.
export const COMPRESS_PRESETS = ['screen', 'ebook', 'print', 'lossless'] as const;
export type CompressPreset = (typeof COMPRESS_PRESETS)[number];

export type CompressDeps = FileJobDeps;

// The outcome: the sizes in bytes, and the copy the job wrote. The copy is present even when it is
// not smaller; the dialog offers it only when it is.
export interface CompressResult {
  readonly before: number;
  readonly after: number;
  readonly file: ResultFile | undefined;
}

// Runs one compress with a preset. Resolves with the sizes and the copy; rejects with an RpcError,
// or FileJobCancelled (the file job's cancel).
export async function runCompress(
  deps: CompressDeps,
  handle: string,
  preset: CompressPreset,
): Promise<CompressResult> {
  const output = await runFileJobOutput(deps, handle, 'reduce_size', { preset });
  // The job's value is ReduceSizeValue: before, after and the notes. The notes are the engine's own
  // English text, so the dialog does not show them; it says what it knows through t() instead.
  const value = expectObject(output.value, 'result.value');
  return {
    before: expectInteger(field(value, 'before', 'result.value'), 'result.value.before'),
    after: expectInteger(field(value, 'after', 'result.value'), 'result.value.after'),
    file: output.files[0],
  };
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
