// The Space Usage flow (issue 737): the audit job run through the shared file job flow
// (src/files/fileJob.ts). The audit is read-only and returns a report, not files, so the flow reads
// the report kind. Its value is the same audit the compress result shows (readAudit, compressJob.ts).
import { type FileJobDeps, runFileJobOutput } from '../files/fileJob';
import { readAudit, type SpaceAudit } from '../compress/compressJob';

export type SpaceUsageDeps = FileJobDeps;

// Runs the audit of the open document. Resolves with the audit; rejects with an RpcError, or
// FileJobCancelled (the file job's cancel). The dialog reports the outcome itself, so the job bar
// stays quiet (ownToasts), as the comments export does.
export async function runSpaceUsage(deps: SpaceUsageDeps, handle: string): Promise<SpaceAudit> {
  const output = await runFileJobOutput(
    { ...deps, ownToasts: true },
    handle,
    'audit',
    {},
    'report',
  );
  const audit = readAudit(output.value, 'result.value');
  if (audit === null) {
    throw new TypeError('the audit returned no value');
  }
  return audit;
}
