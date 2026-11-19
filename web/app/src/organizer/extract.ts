// Extract (W6.1b slice 2): the selected pages as one new PDF. It is the split job with one range,
// so it runs through the same job flow as Split (the job bar's progress and Cancel). The document
// itself does not change, so the extract has no undo step.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJob } from '../files/fileJob';
import { splitArgs } from '../split/splitJob';

// The name the extract is downloaded as, the same one the desktop gives it.
export function extractName(documentName: string): string {
  return `${documentName.replace(/\.pdf$/i, '')} (extract).pdf`;
}

// Runs the extract for the chosen pages (zero-based, in the order chosen) and returns the file.
export async function runExtract(
  deps: FileJobDeps,
  handle: string,
  picked: readonly number[],
): Promise<ResultFile> {
  const files = await runFileJob(
    deps,
    handle,
    'split',
    splitArgs({ mode: 'ranges', parts: [picked] }),
  );
  const file = files[0];
  if (file === undefined) throw new Error('the extract made no file');
  return file;
}
