// The compare flow (A11, W7.8) through the job protocol of W1.2 section 13: jobs.prepare on the
// engine (the open document is the older one), job.run in the job worker with the newer document
// as a binary argument, then jobs.apply on the engine, which ends the job. A compare changes
// nothing, so its result is the report, not a document. Cancel calls jobs.abort and stops the job
// worker (W1.1 section 1). Progress goes to the app's job bar.
import { RpcError, type RpcErrorCode } from '../rpc/client';
import { ERROR_CODES, type Methods, PROTOCOL_VERSION } from '../rpc/generated';
import {
  checkKeys,
  expectArray,
  expectBoolean,
  expectInteger,
  expectObject,
  expectOneOf,
  expectString,
  field,
  orNull,
  ReplyShapeError,
} from '../rpc/shape';
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import type { JobWorker, SplitEngine } from '../split/splitJob';

// The engine calls the flow makes. The RPC client satisfies it; tests pass a fake.
export type CompareEngine = SplitEngine;

export interface CompareOptions {
  readonly text: boolean;
  readonly visual: boolean;
}

// One difference, as the job reports it. A page is 0-based; null means the page is only in the
// other document. The summary is the service's own one-line text.
export interface CompareChange {
  readonly kind: string;
  readonly pageA: number | null;
  readonly pageB: number | null;
  readonly summary: string;
}

// The aligned pages (older, newer), and the changes. Identical documents have no changes.
export interface CompareReport {
  readonly identical: boolean;
  readonly pairs: readonly (readonly [number | null, number | null])[];
  readonly changes: readonly CompareChange[];
}

export interface CompareDeps {
  readonly engine: CompareEngine;
  readonly startWorker: () => JobWorker;
  readonly progress?: JobProgressStore;
}

// Thrown when the user cancelled. The dialog treats it as a normal end, not an error.
export class CompareCancelled extends Error {
  constructor() {
    super('the comparison was cancelled');
    this.name = 'CompareCancelled';
  }
}

// The job arguments, as CompareArgs in webapi/dto.py takes them. The newer document is added as
// the binary value `other` by runCompare, since its bytes travel as a buffer.
export function compareArgs(options: CompareOptions): Record<string, unknown> {
  return { text: options.text, visual: options.visual };
}

// A page index that may be absent: null means the page is only in the other document.
function pageIndex(raw: unknown, path: string): number | null {
  return orNull(raw, path, (item, at) => expectInteger(item, at));
}

// Reads the job worker's reply to job.run. A failure comes back as an error reply; a result is
// kind "report", and its value is the CompareValue of webapi/dto.py.
export function readCompareReply(result: { reply: string }): CompareReport {
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
  const job = expectObject(field(reply, 'result', 'reply'), 'result');
  if (field(job, 'kind', 'result') !== 'report') {
    throw new ReplyShapeError('result.kind', 'a compare returns a report');
  }
  const value = expectObject(field(job, 'value', 'result'), 'result.value');
  const pairs = expectArray(field(value, 'pairs', 'value'), 'value.pairs').map((pair, index) => {
    const path = `value.pairs[${index}]`;
    const items = expectArray(pair, path);
    if (items.length !== 2) throw new ReplyShapeError(path, 'expected two pages');
    return [pageIndex(items[0], `${path}[0]`), pageIndex(items[1], `${path}[1]`)] as const;
  });
  const changes = expectArray(field(value, 'changes', 'value'), 'value.changes').map(
    (item, index) => {
      const path = `value.changes[${index}]`;
      const change = expectObject(item, path);
      return {
        kind: expectString(field(change, 'kind', path), `${path}.kind`),
        pageA: pageIndex(field(change, 'page_a', path), `${path}.page_a`),
        pageB: pageIndex(field(change, 'page_b', path), `${path}.page_b`),
        summary: expectString(field(change, 'summary', path), `${path}.summary`),
      };
    },
  );
  return {
    identical: expectBoolean(field(value, 'identical', 'value'), 'value.identical'),
    pairs,
    changes,
  };
}

// Runs one comparison. Resolves with the report; rejects with an RpcError, or CompareCancelled.
// `other` is the newer document's bytes: the prepare call gets a copy (the engine call transfers
// its buffers), and the job worker gets the original.
export async function runCompare(
  deps: CompareDeps,
  handle: string,
  other: ArrayBuffer,
  options: CompareOptions,
): Promise<CompareReport> {
  const progress = deps.progress ?? jobProgress;
  const { engine } = deps;
  const args = compareArgs(options);
  const prepared = await engine.call('jobs.prepare', {
    handle,
    job: 'compare',
    args: { ...args, other: other.slice(0) },
  });
  const { token } = prepared;

  const worker = deps.startWorker();
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new CompareCancelled());
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
      params: {
        job: 'compare',
        args: { ...args, other: { $bin: 1 } },
        document: { $bin: 0 },
      },
    });
    const result = await Promise.race([
      worker.call(request, [prepared.document, other]),
      cancelled,
    ]);
    const report = readCompareReply(result);
    await engine.call('jobs.apply', {
      handle,
      token,
      document: null,
      label: '',
      require_full_save: false,
    });
    progress.finish(token, { ok: true });
    return report;
  } catch (error) {
    if (error instanceof CompareCancelled) throw error;
    // Frees the prepared job. Best effort: the engine drops unused jobs on the next prepare.
    await engine.call('jobs.abort', { handle, token }).catch(() => undefined);
    progress.finish(token, { ok: false, error });
    throw error;
  } finally {
    worker.terminate();
  }
}
