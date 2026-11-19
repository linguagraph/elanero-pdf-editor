// A long action that changes the document, run as a mutating job (W7.4, W1.2 section 13). jobs.prepare
// begins the task and copies the document; the job worker runs the action on the copy (job.run with
// job "action"); jobs.apply ends the task and applies the result as one undoable step. Cancel calls
// jobs.abort and stops the job worker, and the document is left alone. Progress goes to the app's
// job bar. The action's own name and arguments are sent unchanged, as the actions layer takes them.
import type { CallResult } from '../engine/loader';
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import { RpcError, type RpcErrorCode } from '../rpc/client';
import { type ChangedDto, ERROR_CODES, type Methods, PROTOCOL_VERSION } from '../rpc/generated';
import {
  checkKeys,
  expectBoolean,
  expectInteger,
  expectObject,
  expectOneOf,
  expectString,
  field,
  ReplyShapeError,
} from '../rpc/shape';

// The engine calls the flow makes. The RPC client satisfies it; tests pass a fake.
export interface ActionJobEngine {
  call<M extends 'jobs.prepare' | 'jobs.apply' | 'jobs.abort'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

// One job worker. call() sends one request with its binary values, as the engine channel does.
export interface ActionJobWorker {
  call(request: string, buffers?: readonly ArrayBuffer[]): Promise<CallResult>;
  terminate(): void;
}

export interface ActionJobDeps {
  readonly engine: ActionJobEngine;
  readonly startWorker: () => ActionJobWorker;
  readonly progress?: JobProgressStore;
}

// Thrown when the user cancelled. The caller treats it as a normal end, not an error.
export class ActionJobCancelled extends Error {
  constructor() {
    super('the action was cancelled');
    this.name = 'ActionJobCancelled';
  }
}

export interface ActionJobOutcome {
  // The undo label of the step the job applied.
  readonly label: string;
  // The pages and parts that changed, for redrawing (W1.2 section 7); null when nothing moved.
  readonly changed: ChangedDto | null;
  // The action's own result, as the job reported it (W1.3 ActionResult.value).
  readonly value: unknown;
}

interface ActionJobReply {
  readonly label: string;
  readonly requireFullSave: boolean;
  readonly document: ArrayBuffer;
  readonly value: unknown;
}

// Reads the job worker's reply to job.run. A failure comes back as an error reply; a mutating job
// returns kind "document" with the result document as its one binary value.
export function readActionReply(result: CallResult): ActionJobReply {
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
    const details = error['details'];
    throw new RpcError(
      code as RpcErrorCode,
      message,
      details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {},
    );
  }
  checkKeys(reply, ['v', 'id', 'ok', 'result', 'events'], 'reply');
  const value = expectObject(field(reply, 'result', 'reply'), 'result');
  if (field(value, 'kind', 'result') !== 'document') {
    throw new ReplyShapeError('result.kind', 'an action job returns a document');
  }
  const ref = expectObject(field(value, 'document', 'result'), 'result.document');
  if (result.buffer === undefined || expectInteger(field(ref, '$bin', 'document'), '$bin') !== 0) {
    throw new ReplyShapeError('result.document', 'no buffer for the document');
  }
  return {
    label: expectString(field(value, 'label', 'result'), 'result.label'),
    requireFullSave: expectBoolean(
      field(value, 'require_full_save', 'result'),
      'result.require_full_save',
    ),
    document: result.buffer,
    value: value['value'],
  };
}

// Runs one action job on the document. Resolves with the outcome; rejects with an RpcError (the
// prepare refusal, for one, keeps its details), or with ActionJobCancelled.
export async function runActionJob(
  deps: ActionJobDeps,
  handle: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ActionJobOutcome> {
  const progress = deps.progress ?? jobProgress;
  const { engine } = deps;
  const prepared = await engine.call('jobs.prepare', {
    handle,
    job: 'action',
    args: { name, args },
  });
  const { token } = prepared;

  const worker = deps.startWorker();
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new ActionJobCancelled());
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
      params: { job: 'action', args: { name, args }, document: { $bin: 0 } },
    });
    const result = await Promise.race([worker.call(request, [prepared.document]), cancelled]);
    const reply = readActionReply(result);
    const applied = await engine.call('jobs.apply', {
      handle,
      token,
      document: reply.document,
      label: reply.label,
      require_full_save: reply.requireFullSave,
    });
    progress.finish(token, { ok: true });
    return { label: reply.label, changed: applied.changed, value: reply.value };
  } catch (error) {
    if (error instanceof ActionJobCancelled) throw error;
    // Frees the prepared job. Best effort: the engine drops unused jobs on the next prepare.
    await engine.call('jobs.abort', { handle, token }).catch(() => undefined);
    progress.finish(token, { ok: false, error });
    throw error;
  } finally {
    worker.terminate();
  }
}
