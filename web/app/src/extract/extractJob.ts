// The Extract Images flow (W4.15): the extract_images job run through the shared file job flow
// (src/files/fileJob.ts). The job is read-only: its files are the images, one file or one ZIP, and
// its value counts the images saved and the ones skipped for their size.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJobOutput } from '../files/fileJob';
import {
  type ExtractChoice,
  type ExtractFontsValue,
  type ExtractImagesValue,
  extractFontsArgs,
  extractImagesArgs,
  readExtractFontsValue,
  readExtractImagesValue,
} from './extractChoice';

export const EXTRACT_IMAGES_JOB = 'extract_images';

export interface ExtractImagesOutput {
  readonly files: ResultFile[];
  readonly value: ExtractImagesValue;
}

// Runs one extraction. Resolves with the files and the value; rejects with an RpcError, or
// FileJobCancelled.
export async function runExtractImages(
  deps: FileJobDeps,
  handle: string,
  choice: ExtractChoice,
  name: string,
): Promise<ExtractImagesOutput> {
  const output = await runFileJobOutput(
    deps,
    handle,
    EXTRACT_IMAGES_JOB,
    extractImagesArgs(name, choice),
  );
  return { files: output.files, value: readExtractImagesValue(output.value) };
}

export const EXTRACT_FONTS_JOB = 'extract_fonts';

export interface ExtractFontsOutput {
  readonly files: ResultFile[];
  readonly value: ExtractFontsValue;
}

// Runs one font extraction over the whole document. Resolves with the files and the value; rejects
// with an RpcError, or FileJobCancelled.
export async function runExtractFonts(
  deps: FileJobDeps,
  handle: string,
  name: string,
): Promise<ExtractFontsOutput> {
  const output = await runFileJobOutput(deps, handle, EXTRACT_FONTS_JOB, extractFontsArgs(name));
  return { files: output.files, value: readExtractFontsValue(output.value) };
}
