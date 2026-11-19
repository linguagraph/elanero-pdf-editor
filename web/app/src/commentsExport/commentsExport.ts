// The comment export (W7.2 A5): the comments_export job run through the shared file job flow
// (src/files/fileJob.ts). The job is read-only and its result is one file: the XFDF of the comments,
// or the CSV or PDF summary the Comments panel writes on the desktop. Nothing here changes the
// document, so the export has no undo step.
import type { ResultFile } from '../files/downloads';
import { type FileJobDeps, runFileJob } from '../files/fileJob';

export const COMMENTS_EXPORT_JOB = 'comments_export';

export type CommentsExportFormat = 'xfdf' | 'csv' | 'pdf';

export const COMMENTS_EXPORT_FORMATS: readonly CommentsExportFormat[] = ['xfdf', 'csv', 'pdf'];

export function commentsExportArgs(
  format: CommentsExportFormat,
  name: string,
): Record<string, unknown> {
  return { format, name };
}

// The file name the job will write, as the dialog shows it before the export runs. The job names
// the file from the document's stem (the engine sanitises it), so this is a preview: the download
// takes the name from the job's reply.
export function commentsExportFileName(format: CommentsExportFormat, name: string): string {
  const stem =
    name
      .trim()
      .replace(/[/\\]/g, '_')
      .replace(/\.[^.]*$/, '') || 'document';
  if (format === 'xfdf') return `${stem}.xfdf`;
  if (format === 'csv') return `${stem}-comments.csv`;
  return `${stem}-comments.pdf`;
}

// Runs one comment export. Resolves with its file; rejects with an RpcError, or FileJobCancelled.
export function runCommentsExport(
  deps: FileJobDeps,
  handle: string,
  format: CommentsExportFormat,
  name: string,
): Promise<ResultFile[]> {
  // The dialog reports the outcome (one success or error toast), so the job bar stays quiet.
  return runFileJob(
    { ...deps, ownToasts: true },
    handle,
    COMMENTS_EXPORT_JOB,
    commentsExportArgs(format, name),
  );
}
