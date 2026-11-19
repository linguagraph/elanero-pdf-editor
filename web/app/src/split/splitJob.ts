// The split flow (W6.2) through the job protocol of W1.2 section 13: jobs.prepare on the engine,
// job.run in the job worker, then jobs.apply on the engine, which ends the job. A split is
// read-only, so its result is the files, not a document. Cancel calls jobs.abort and stops the job
// worker (W1.1 section 1). Progress goes to the app's job bar.
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

// The engine calls the flow makes. The RPC client satisfies it; tests pass a fake.
export interface SplitEngine {
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

// What the dialog asks for. Page numbers are 0-based, as the job takes them.
export type SplitChoice =
  | { readonly mode: 'pages'; readonly pagesPerFile: number }
  | { readonly mode: 'ranges'; readonly parts: readonly (readonly number[])[] }
  | { readonly mode: 'bookmarks' }
  | { readonly mode: 'size'; readonly maxBytes: number };

export interface SplitFile {
  readonly name: string; // the path the job wrote, relative to its folder
  readonly mime: string;
  readonly data: ArrayBuffer;
}

export interface SplitDeps {
  readonly engine: SplitEngine;
  readonly startWorker: () => JobWorker;
  readonly progress?: JobProgressStore;
}

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

// Reads the job worker's reply to job.run. A failure comes back as an error reply; a result is
// kind "files". The reply carries one binary value at most, so one file is the most it can hold.
export function readRunReply(result: CallResult): SplitFile[] {
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
    throw new ReplyShapeError('result.kind', 'a split returns files');
  }
  const items = expectArray(field(value, 'files', 'result'), 'result.files');
  if (items.length > 1) {
    // The engine's channel carries one binary value per reply, so several parts cannot come back
    // yet. This is refused with a clear error rather than returning a partial result.
    throw new RpcError('INTERNAL', 'a split with more than one file cannot be returned yet');
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

// Runs one split. Resolves with the files; rejects with an RpcError, or SplitCancelled.
export async function runSplit(
  deps: SplitDeps,
  handle: string,
  choice: SplitChoice,
): Promise<SplitFile[]> {
  const progress = deps.progress ?? jobProgress;
  const { engine } = deps;
  const args = splitArgs(choice);
  const prepared = await engine.call('jobs.prepare', { handle, job: 'split', args });
  const { token } = prepared;

  const worker = deps.startWorker();
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new SplitCancelled());
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
      params: { job: 'split', args, document: { $bin: 0 } },
    });
    const result = await Promise.race([worker.call(request, [prepared.document]), cancelled]);
    const files = readRunReply(result);
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
    if (error instanceof SplitCancelled) throw error;
    // Frees the prepared job. Best effort: the engine drops unused jobs on the next prepare.
    await engine.call('jobs.abort', { handle, token }).catch(() => undefined);
    progress.finish(token, { ok: false, error });
    throw error;
  } finally {
    worker.terminate();
  }
}
