// The split flow (W6.2): the split job's arguments and its run through the shared file job flow
// (src/files/fileJob.ts). A split is read-only, so its result is the files, not a document.
import type { CallResult } from '../engine/loader';
import type { ResultFile } from '../files/downloads';
import { FileJobCancelled, type FileJobDeps, readFilesReply, runFileJob } from '../files/fileJob';
import type { Methods } from '../rpc/generated';

export type { JobWorker } from '../files/fileJob';

export type SplitFile = ResultFile;

// The engine calls a split makes: the file job's, and split.plan for the preview. The RPC client
// satisfies it.
export interface SplitEngine {
  call<M extends 'jobs.prepare' | 'jobs.apply' | 'jobs.abort' | 'system.memory' | 'split.plan'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

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

// What the split writes: one file per part, or one ZIP of the parts (W6.2 section 3).
export interface SplitOutput {
  // The document's display name: the stem of the part names.
  readonly name: string;
  readonly zip: boolean;
}

// The job arguments, as SplitArgs in webapi/dto.py takes them. Every field is sent, so the job
// never relies on a default the browser does not know about.
export function splitArgs(choice: SplitChoice, output: SplitOutput): Record<string, unknown> {
  const base = {
    pages_per_file: 1,
    ranges: [],
    max_bytes: 0,
    name: output.name,
    zip: output.zip,
  };
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

// One part of a split as the preview lists it: the file name the job will write, and its pages
// (0-based, the first and the last; a range's pages may skip some between them).
export type SplitPart = Methods['split.plan']['result']['parts'][number];

// The files a split would make, from split.plan on the engine (read-only; W6.2 section 5). A size
// split has no preview: its parts are sized only by writing them, so the call is not made.
export async function planSplit(
  engine: SplitEngine,
  handle: string,
  choice: SplitChoice,
  name: string,
): Promise<readonly SplitPart[]> {
  if (choice.mode === 'size') return [];
  const params: Methods['split.plan']['params'] = {
    handle,
    mode: choice.mode,
    pages_per_file: choice.mode === 'pages' ? choice.pagesPerFile : 1,
    ranges: choice.mode === 'ranges' ? choice.parts.map((part) => [...part]) : [],
    name,
  };
  return (await engine.call('split.plan', params)).parts;
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
  output: SplitOutput,
): Promise<SplitFile[]> {
  try {
    return await runFileJob(deps, handle, 'split', splitArgs(choice, output));
  } catch (error) {
    if (error instanceof FileJobCancelled) throw new SplitCancelled();
    throw error;
  }
}
