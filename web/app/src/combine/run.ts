// The combine flow (W6.3): checks the sources, starts the merge job on a job worker, reports it to
// the job store (progress bar, Cancel, error toast) and returns the merged bytes for the download.
// Nothing here draws; the dialog calls it and shows the outcome.
import { MAX_FILE_BYTES } from '../documents/openFile';
import type { WorkerClient } from '../engine/start';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';
import type { JobProgressStore } from '../feedback/jobRun';
import { runMergeJob } from './merge';
import { MIN_SOURCES, type SourceItem } from './sources';

export type CombineOutcome =
  | { readonly status: 'done'; readonly name: string; readonly bytes: ArrayBuffer }
  | { readonly status: 'refused'; readonly message: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly error: RpcError };

export interface CombineDeps {
  readonly store: JobProgressStore;
  // A new job worker for this job. The flow terminates it when the job ends.
  readonly startWorker: () => WorkerClient;
}

let nextToken = 1;

// Converts whatever a failed read or call threw into an RpcError, as the other flows do.
function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError('INTERNAL', `the files could not be combined: ${message}`);
}

// The checks that come before any job starts: at least two sources, and no file above the same
// 1 GiB limit that opening uses. A refusal returns the message to show, and starts nothing.
export function checkSources(items: readonly SourceItem[]): string | null {
  if (items.length < MIN_SOURCES) return t('combine.needTwo');
  const big = items.find((item) => item.file.size > MAX_FILE_BYTES);
  if (big !== undefined) return t('combine.tooLarge', { name: big.name });
  return null;
}

// Runs the combine. The job's token is local (merge has no prepare); the store shows the bar, and
// finish reports the outcome, with an error toast when the job fails.
export async function runCombine(
  items: readonly SourceItem[],
  deps: CombineDeps,
): Promise<CombineOutcome> {
  const refusal = checkSources(items);
  if (refusal !== null) return { status: 'refused', message: refusal };

  const worker = deps.startWorker();
  const token = `merge-${nextToken++}`;
  let cancelled = false;
  const stop = (): void => {
    cancelled = true;
    worker.terminate();
  };
  if (!deps.store.begin({ token, label: t('combine.label'), terminate: stop })) {
    worker.terminate();
    return { status: 'refused', message: t('combine.busy') };
  }

  try {
    const sources = await Promise.all(
      items.map(async (item) => ({ name: item.name, data: await item.file.arrayBuffer() })),
    );
    const output = await runMergeJob(worker, sources);
    deps.store.finish(token, { ok: true });
    return { status: 'done', name: output.name, bytes: output.bytes };
  } catch (error) {
    if (cancelled) return { status: 'cancelled' };
    const rpcError = asRpcError(error);
    deps.store.finish(token, { ok: false, error: rpcError });
    return { status: 'failed', error: rpcError };
  } finally {
    worker.terminate();
  }
}
