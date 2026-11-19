// The print flow (W6.5): jobs.prepare for print_pages, the job run on the job worker, the progress
// bar with Cancel, then the browser's print path. The job is read-only, so the document is not
// changed; the copy's token is given back with jobs.abort once the pages are in hand.
import type { WorkerClient } from '../engine/start';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { JobAbortParams, JobPrepareResult, Methods } from '../rpc/generated';
import { printImages, type PrintFile, type PrintImagesOptions } from './printPages';
import { type PrintJobArgs, runPrintWorker } from './printWorker';

// The two calls the flow makes on the engine worker.
export interface PrintRpc {
  call<M extends 'jobs.prepare' | 'jobs.abort'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

export interface PrintJobOptions {
  readonly rpc: PrintRpc;
  readonly handle: string;
  readonly pages: readonly number[] | undefined;
  readonly dpi: number;
  readonly comments: boolean;
  // Starts the job worker. Called once, when the job is about to run.
  readonly startWorker: (() => WorkerClient) | undefined;
  readonly store?: JobProgressStore;
  readonly toasts?: ToastStore;
  // Prints the returned pages. Tests replace the browser's print path here.
  readonly printFiles?: (files: readonly PrintFile[], options: PrintImagesOptions) => Promise<void>;
}

function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError('INTERNAL', message);
}

// Runs one print. Resolves when the print dialog has been opened or the job has ended with an
// error that was reported to the user. Cancel terminates the job worker and aborts the copy.
export async function runPrintJob(options: PrintJobOptions): Promise<void> {
  const store = options.store ?? jobProgress;
  const toastStore = options.toasts ?? toasts;
  const args: PrintJobArgs = {
    ...(options.pages === undefined ? {} : { pages: options.pages }),
    dpi: options.dpi,
    annotations: options.comments,
  };

  let prepared: JobPrepareResult;
  try {
    prepared = await options.rpc.call('jobs.prepare', {
      handle: options.handle,
      job: 'print_pages',
      args,
    });
  } catch (error) {
    reportRpcError(toastStore, asRpcError(error));
    return;
  }

  let worker: WorkerClient | undefined;
  const abortClient = {
    async call(method: 'jobs.abort', params: JobAbortParams): Promise<unknown> {
      worker?.terminate();
      return options.rpc.call(method, params);
    },
  };
  const started = store.begin({
    handle: options.handle,
    token: prepared.token,
    label: t('print.title'),
    client: abortClient,
  });
  if (!started) {
    await options.rpc
      .call('jobs.abort', { handle: options.handle, token: prepared.token })
      .catch(() => undefined);
    toastStore.push('info', t('print.busy'));
    return;
  }

  let files: readonly PrintFile[];
  try {
    if (options.startWorker === undefined) {
      throw new RpcError('INTERNAL', 'printing is not available in this build');
    }
    worker = options.startWorker();
    files = await runPrintWorker(worker, args, prepared.document);
  } catch (error) {
    store.finish(prepared.token, { ok: false, error });
    return;
  } finally {
    worker?.terminate();
  }
  store.finish(prepared.token, { ok: true });
  await options.rpc
    .call('jobs.abort', { handle: options.handle, token: prepared.token })
    .catch(() => undefined);
  const printFiles = options.printFiles ?? printImages;
  try {
    await printFiles(files, { dpi: options.dpi });
  } catch (error) {
    reportRpcError(toastStore, asRpcError(error));
  }
}
