// The Extract Images flow (W4.15): the extract_images job run through the shared file job flow
// (src/files/fileJob.ts). The job is read-only: its files are the images, one file or one ZIP, and
// its value counts the images saved and the ones skipped for their size.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJobOutput } from '../files/fileJob';
import {
  type ExtractChoice,
  type ExtractImagesValue,
  extractImagesArgs,
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
