// The job flow for a job that returns files (W1.2 section 13): jobs.prepare on the engine, job.run
// in a job worker, then jobs.apply on the engine, which ends the job. A file job is read-only, so
// its result is the files, not a document. Cancel calls jobs.abort and stops the job worker
// (W1.1 section 1). Progress goes to the app's job bar. The split (W6.2) and the export (W7.7) use
// this one flow; each passes its job type name and arguments.
import type { CallResult } from '../engine/loader';
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
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import type { ResultFile } from './downloads';

// The engine calls the flow makes. The RPC client satisfies it; tests pass a fake.
export interface FileJobEngine {
  call<M extends 'jobs.prepare' | 'jobs.apply' | 'jobs.abort'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

// One job worker. call() sends one request with its binary values, as the engine channel does.
export interface JobWorker {
  call(request: string, buffers?: readonly ArrayBuffer[]): Promise<CallResult>;
  terminate(): void;
}

export interface FileJobDeps {
  readonly engine: FileJobEngine;
  readonly startWorker: () => JobWorker;
  readonly progress?: JobProgressStore;
}

// Thrown when the user cancelled. A dialog treats it as a normal end, not an error.
export class FileJobCancelled extends Error {
  constructor() {
    super('the job was cancelled');
    this.name = 'FileJobCancelled';
  }
}

// Reads the job worker's reply to job.run. A failure comes back as an error reply; a result is
// kind "files". The reply carries one binary value at most, so one file is the most it can hold:
// a job with several files packs them into one (the export writes a ZIP).
export function readFilesReply(result: CallResult, job: string): ResultFile[] {
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
  if (items.length > 1) {
    // The engine's channel carries one binary value per reply, so several files cannot come back
    // yet. This is refused with a clear error rather than returning a partial result.
    throw new RpcError('INTERNAL', `a ${job} job with more than one file cannot be returned yet`);
  }
  const buffer = result.buffer;
  return items.map((item) => {
    const entry = expectObject(item, 'result.files[]');
    const ref = expectObject(field(entry, 'data', 'result.files[]'), 'result.files[].data');
    if (buffer === undefined || expectInteger(field(ref, '$bin', 'data'), 'data.$bin') !== 0) {
      throw new ReplyShapeError('result.files[].data', 'no buffer for the file');
    }
    return {
      name: expectString(field(entry, 'name', 'result.files[]'), 'name'),
      mime: expectString(field(entry, 'mime', 'result.files[]'), 'mime'),
      data: buffer,
    };
  });
}

// Runs one file job. Resolves with the files; rejects with an RpcError, or FileJobCancelled.
export async function runFileJob(
  deps: FileJobDeps,
  handle: string,
  job: string,
  args: Record<string, unknown>,
): Promise<ResultFile[]> {
  const progress = deps.progress ?? jobProgress;
  const { engine } = deps;
  const prepared = await engine.call('jobs.prepare', { handle, job, args });
  const { token } = prepared;

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

  try {
    const request = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      method: 'job.run',
      params: { job, args, document: { $bin: 0 } },
    });
    const result = await Promise.race([worker.call(request, [prepared.document]), cancelled]);
    const files = readFilesReply(result, job);
    await engine.call('jobs.apply', {
      handle,
      token,
      document: null,
      label: '',
      require_full_save: false,
    });
    progress.finish(token, { ok: true });
    return files;
  } catch (error) {
    if (error instanceof FileJobCancelled) throw error;
    // Frees the prepared job. Best effort: the engine drops unused jobs on the next prepare.
    await engine.call('jobs.abort', { handle, token }).catch(() => undefined);
    progress.finish(token, { ok: false, error });
    throw error;
  } finally {
    worker.terminate();
  }
}
