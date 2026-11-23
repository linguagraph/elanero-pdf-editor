// The job flow for a job that returns files (W1.2 section 13): jobs.prepare on the engine, job.run
// in a job worker, then jobs.apply on the engine, which ends the job. A file job is read-only, so
// its result is the files, not a document. Cancel calls jobs.abort and stops the job worker
// (W1.1 section 1). Progress goes to the app's job bar. The split (W6.2) and the export (W7.7) use
// this one flow; each passes its job type name and arguments.
import type { CallResult, Notice } from '../engine/loader';
import { RpcError, type RpcErrorCode } from '../rpc/client';
import { ERROR_CODES, type Methods, PROTOCOL_VERSION } from '../rpc/generated';
import {
  checkKeys,
  expectArray,
  expectInteger,
  expectObject,
  expectOneOf,
  expectString,
  field,
  ReplyShapeError,
} from '../rpc/shape';
import { type JobProgressStore, jobProgress, progressPercent } from '../feedback/jobRun';
import { memoryWarner } from '../feedback/memoryWarning';
import type { ResultFile } from './downloads';

// The engine calls the flow makes. The RPC client satisfies it; tests pass a fake.
export interface FileJobEngine {
  call<M extends 'jobs.prepare' | 'jobs.apply' | 'jobs.abort' | 'system.memory'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

// One job worker. call() sends one request with its binary values, as the engine channel does.
export interface JobWorker {
  call(
    request: string,
    buffers?: readonly ArrayBuffer[],
    onNotice?: (notice: Notice) => void,
  ): Promise<CallResult>;
  terminate(): void;
}

export interface FileJobDeps {
  readonly engine: FileJobEngine;
  readonly startWorker: () => JobWorker;
  readonly progress?: JobProgressStore;
  // Aborting it cancels this run, and only this run's job. Before prepare returns, the run stops
  // once prepare returns (and frees the prepared job); before the bar shows the job, it never
  // starts. Once running, it is cancelled as the bar's Cancel cancels it.
  readonly signal?: AbortSignal;
  // The caller reports the outcome itself (its toasts are more specific than the job bar's). The
  // bar then hides with no success or error toast, so the user sees one message per result.
  readonly ownToasts?: boolean;
}

// Thrown when the user cancelled. A dialog treats it as a normal end, not an error.
export class FileJobCancelled extends Error {
  constructor() {
    super('the job was cancelled');
    this.name = 'FileJobCancelled';
  }
}

// What a file job returns: its files, and the job's own value (the reduce's sizes, for one), as
// the job worker wrote it. The value is null when the job has none.
export interface FileJobOutput {
  readonly files: ResultFile[];
  readonly value: unknown;
}

// Reads the job worker's reply to job.run. A failure comes back as an error reply; a result is
// kind "files". Each file's bytes are one of the reply's buffers, in $bin order (W1.2 section 5).
export function readFilesReply(result: CallResult, job: string): ResultFile[] {
  return readFileJobOutput(result, job).files;
}

// The same reply, with the job's value as well (see FileJobOutput).
export function readFileJobOutput(result: CallResult, job: string): FileJobOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.reply);
  } catch {
    throw new ReplyShapeError('reply', 'not valid JSON');
  }
  const reply = expectObject(parsed, 'reply');
  const version = expectInteger(field(reply, 'v', 'reply'), 'reply.v');
  if (version !== PROTOCOL_VERSION) {
    throw new RpcError('PROTOCOL_MISMATCH', 'the job worker speaks another protocol version', {
      engine: version,
      app: PROTOCOL_VERSION,
    });
  }
  if (field(reply, 'ok', 'reply') !== true) {
    const error = expectObject(field(reply, 'error', 'reply'), 'reply.error');
    const code = expectOneOf(field(error, 'code', 'reply.error'), ERROR_CODES, 'reply.error.code');
    const message = expectString(field(error, 'message', 'reply.error'), 'reply.error.message');
    throw new RpcError(code as RpcErrorCode, message);
  }
  checkKeys(reply, ['v', 'id', 'ok', 'result', 'events'], 'reply');
  const value = expectObject(field(reply, 'result', 'reply'), 'result');
  if (field(value, 'kind', 'result') !== 'files') {
    throw new ReplyShapeError('result.kind', `a ${job} job returns files`);
  }
  const items = expectArray(field(value, 'files', 'result'), 'result.files');
  // The file bytes are the reply's buffers, in $bin order: one buffer per file.
  const buffers = result.buffers ?? (result.buffer === undefined ? [] : [result.buffer]);
  const files = items.map((item) => {
    const entry = expectObject(item, 'result.files[]');
    const ref = expectObject(field(entry, 'data', 'result.files[]'), 'result.files[].data');
    const data = buffers[expectInteger(field(ref, '$bin', 'data'), 'data.$bin')];
    if (data === undefined) {
      throw new ReplyShapeError('result.files[].data', 'no buffer for the file');
    }
    return {
      name: expectString(field(entry, 'name', 'result.files[]'), 'name'),
      mime: expectString(field(entry, 'mime', 'result.files[]'), 'mime'),
      data,
    };
  });
  return { files, value: field(value, 'value', 'result') ?? null };
}

// Runs one file job. Resolves with the files; rejects with an RpcError, or FileJobCancelled.
export async function runFileJob(
  deps: FileJobDeps,
  handle: string,
  job: string,
  args: Record<string, unknown>,
): Promise<ResultFile[]> {
  return (await runFileJobOutput(deps, handle, job, args)).files;
}

// Runs one file job and returns its files with the job's value (see FileJobOutput).
export async function runFileJobOutput(
  deps: FileJobDeps,
  handle: string,
  job: string,
  args: Record<string, unknown>,
): Promise<FileJobOutput> {
  const progress = deps.progress ?? jobProgress;
  const quiet = deps.ownToasts === true;
  const { engine } = deps;
  const prepared = await engine.call('jobs.prepare', { handle, job, args });
  const { token } = prepared;
  // A reduce's baseline (the file the user holds, issue #610) goes with its arguments; the engine
  // sends one only for a reduce, so no other job's arguments change.
  const runArgs =
    typeof prepared.baseline === 'number' ? { ...args, before: prepared.baseline } : args;
  if (deps.signal?.aborted === true) {
    // Cancelled while prepare was in flight: nothing is on the bar and no worker has started.
    await engine.call('jobs.abort', { handle, token }).catch(() => undefined);
    throw new FileJobCancelled();
  }
  // The job worker's copy counts against the heap warning (W3.9 D4). Read before the copy is sent.
  void memoryWarner.check(engine, 'job', prepared.document.byteLength);

  const worker = deps.startWorker();
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new FileJobCancelled());
  });
  // A rejection nobody awaits (a finished job) must not surface as an unhandled rejection.
  cancelled.catch(() => undefined);

  const client = {
    // The bar's Cancel: abort the prepared job, then stop the worker. A failed abort keeps both
    // running, and the bar with them, as the bar expects.
    call: async (method: 'jobs.abort', params: Methods['jobs.abort']['params']) => {
      const result = await engine.call(method, params);
      cancel();
      worker.terminate();
      return result;
    },
  };
  if (!progress.begin({ handle, token, label: prepared.label, client })) {
    worker.terminate();
    await engine.call('jobs.abort', { handle, token });
    throw new RpcError('BUSY', 'another job is running');
  }
  // Scoped to this run's token, so an abort never cancels a different job on the bar.
  const onAbort = (): void => {
    void progress.cancel(token);
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const request = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      method: 'job.run',
      params: { job, args: runArgs, document: { $bin: 0 } },
    });
    const onNotice = (notice: Notice): void => {
      const percent = progressPercent(notice);
      if (percent !== undefined) progress.progress(token, percent);
    };
    const result = await Promise.race([
      worker.call(request, [prepared.document], onNotice),
      cancelled,
    ]);
    const output = readFileJobOutput(result, job);
    await engine.call('jobs.apply', {
      handle,
      token,
      document: null,
      label: '',
      require_full_save: false,
    });
    void memoryWarner.check(engine, 'job');
    progress.finish(token, { ok: true, quiet });
    return output;
  } catch (error) {
    if (error instanceof FileJobCancelled) throw error;
    // Frees the prepared job. Best effort: the engine drops unused jobs on the next prepare.
    await engine.call('jobs.abort', { handle, token }).catch(() => undefined);
    progress.finish(token, { ok: false, error, quiet });
    throw error;
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
    worker.terminate();
  }
}
