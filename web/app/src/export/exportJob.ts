// The export flow (W7.7): the export job run through the shared file job flow (src/files/fileJob.ts).
// The job is read-only, so its result is the files: one file, or one ZIP when the pages make several.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJob } from '../files/fileJob';
import { type ExportChoice, exportArgs } from './exportChoice';

export type ExportDeps = FileJobDeps;

// Runs one export. Resolves with the files; rejects with an RpcError, or FileJobCancelled.
export function runExport(
  deps: ExportDeps,
  handle: string,
  choice: ExportChoice,
): Promise<ResultFile[]> {
  return runFileJob(deps, handle, 'export', exportArgs(choice));
}
