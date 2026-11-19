// The split flow (W6.2): the split job's arguments and its run through the shared file job flow
// (src/files/fileJob.ts). A split is read-only, so its result is the files, not a document.
import type { CallResult } from '../engine/loader';
import type { ResultFile } from '../files/downloads';
import { FileJobCancelled, type FileJobDeps, readFilesReply, runFileJob } from '../files/fileJob';

export type { FileJobEngine as SplitEngine, JobWorker } from '../files/fileJob';

export type SplitFile = ResultFile;

// What the dialog asks for. Page numbers are 0-based, as the job takes them.
export type SplitChoice =
  | { readonly mode: 'pages'; readonly pagesPerFile: number }
  | { readonly mode: 'ranges'; readonly parts: readonly (readonly number[])[] }
  | { readonly mode: 'bookmarks' }
  | { readonly mode: 'size'; readonly maxBytes: number };

export type SplitDeps = FileJobDeps;

// Thrown when the user cancelled. The dialog treats it as a normal end, not an error.
export class SplitCancelled extends Error {
  constructor() {
    super('the split was cancelled');
    this.name = 'SplitCancelled';
  }
}

// The job arguments, as SplitArgs in webapi/dto.py takes them. Every field is sent, so the job
// never relies on a default the browser does not know about.
export function splitArgs(choice: SplitChoice): Record<string, unknown> {
  const base = { pages_per_file: 1, ranges: [], max_bytes: 0 };
  switch (choice.mode) {
    case 'pages':
      return { ...base, mode: 'pages', pages_per_file: choice.pagesPerFile };
    case 'ranges':
      return { ...base, mode: 'ranges', ranges: choice.parts.map((part) => [...part]) };
    case 'bookmarks':
      return { ...base, mode: 'bookmarks' };
    case 'size':
      return { ...base, mode: 'size', max_bytes: choice.maxBytes };
  }
}

// Reads the job worker's reply to a split.
export function readRunReply(result: CallResult): SplitFile[] {
  return readFilesReply(result, 'split');
}

// Runs one split. Resolves with the files; rejects with an RpcError, or SplitCancelled.
export async function runSplit(
  deps: SplitDeps,
  handle: string,
  choice: SplitChoice,
): Promise<SplitFile[]> {
  try {
    return await runFileJob(deps, handle, 'split', splitArgs(choice));
  } catch (error) {
    if (error instanceof FileJobCancelled) throw new SplitCancelled();
    throw error;
  }
}
