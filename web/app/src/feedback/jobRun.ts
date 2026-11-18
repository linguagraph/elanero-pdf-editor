// The app's one running-job state (W1.6 section 10, W4.4b). A job that starts (jobs.prepare, then
// the job run) registers here; the progress bar and its Cancel button read the state. Cancel calls
// jobs.abort and hides the bar without a toast, because the user asked for it. A job that ends
// hides the bar and shows a success or error toast. Only one job runs at a time, since a mutating
// job holds the document read-only.
import { useSyncExternalStore } from 'react';
import { RpcError } from '../rpc/client';
import type { JobAbortParams } from '../rpc/generated';
import { t } from '../i18n/t';
import { reportRpcError, toasts, type ToastStore } from './toasts';

// The one call a job's progress bar makes (W4.4b). The RPC client satisfies it.
export interface AbortClient {
  call(method: 'jobs.abort', params: JobAbortParams): Promise<unknown>;
}

export interface StartedJob {
  // The document handle the job runs on, given back to jobs.abort.
  readonly handle: string;
  // The single-use job id from jobs.prepare.
  readonly token: string;
  // The translated task label, from the prepare reply.
  readonly label: string;
  readonly client: AbortClient;
}

export type JobOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export interface RunningJob extends StartedJob {
  readonly percent?: number;
}

export interface JobProgressState {
  readonly job: RunningJob | undefined;
}

export interface JobProgressStore {
  getState(): JobProgressState;
  subscribe(listener: () => void): () => void;
  // Shows the bar for a job. Returns false, and changes nothing, when another job is running.
  begin(job: StartedJob): boolean;
  // Moves the bar. A token that is not the running job's is ignored.
  progress(token: string, percent: number): void;
  // Hides the bar and reports the outcome. A token that is not the running job's is ignored.
  finish(token: string, outcome: JobOutcome): void;
  // Calls jobs.abort. The bar hides when the abort succeeds; a failed abort keeps the bar and
  // shows an error toast.
  cancel(): Promise<void>;
}

export interface JobProgressOptions {
  readonly toasts?: ToastStore;
}

// Any failure, as the RPC error the mapping works on. A plain Error becomes an internal error.
function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError('INTERNAL', message);
}

export function createJobProgressStore(options: JobProgressOptions = {}): JobProgressStore {
  const toastStore = options.toasts ?? toasts;
  let state: JobProgressState = { job: undefined };
  const listeners = new Set<() => void>();

  const update = (next: JobProgressState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(job) {
      if (state.job !== undefined) return false;
      update({ job: { ...job } });
      return true;
    },
    progress(token, percent) {
      if (state.job === undefined || state.job.token !== token) return;
      update({ job: { ...state.job, percent } });
    },
    finish(token, outcome) {
      if (state.job === undefined || state.job.token !== token) return;
      const { label } = state.job;
      update({ job: undefined });
      if (outcome.ok) {
        toastStore.push('success', t('job.done', { label }));
      } else {
        reportRpcError(toastStore, asRpcError(outcome.error));
      }
    },
    async cancel() {
      const job = state.job;
      if (job === undefined) return;
      try {
        await job.client.call('jobs.abort', { handle: job.handle, token: job.token });
      } catch (error) {
        reportRpcError(toastStore, asRpcError(error));
        return;
      }
      if (state.job?.token === job.token) update({ job: undefined });
    },
  };
}

// The app's store. The job flow registers jobs here; App mounts the bar.
export const jobProgress: JobProgressStore = createJobProgressStore();

export function useJobProgress(store: JobProgressStore = jobProgress): JobProgressState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
