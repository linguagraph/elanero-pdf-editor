// The typed RPC client for the engine worker (W1.2 sections 2, 4, 8, 9, 10). It sits on the worker
// client of engine/start.ts and changes nothing there: it encodes the envelope, checks every reply
// against the generated decoders, and maps each failure to an RpcError with a stable code.
import type { WorkerClient } from '../engine/start';
import type { CallResult } from '../engine/loader';
import {
  DEADLINE_MS,
  ERROR_CODES,
  type ChunkedMethod,
  IO_EXTRA,
  METHOD_DEADLINE,
  PROTOCOL_VERSION,
  RESULT_DECODERS,
  type ErrorCode,
  type MethodName,
  type Methods,
} from './generated';
import {
  checkKeys,
  expectArray,
  expectBoolean,
  expectInteger,
  expectObject,
  expectOneOf,
  expectString,
  field,
  newDecodeContext,
  ReplyShapeError,
} from './shape';

// The codes a client can report. Every ErrorCode comes from a reply; TIMEOUT is set by the client
// itself and never sent by the worker, so it is not in the generated union.
export type RpcErrorCode = ErrorCode | 'TIMEOUT';

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: RpcErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
  }
}

// The soft deadline of a call passed. The worker is not terminated: the caller decides whether to
// wait, cancel, or restart the engine (W1.2 section 10).
export class RpcTimeoutError extends RpcError {
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super('TIMEOUT', `${method} did not answer within ${timeoutMs} ms`, { method, timeoutMs });
    this.name = 'RpcTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface CallOptions {
  // Overrides the call's deadline class (W1.2 section 10). Milliseconds.
  timeoutMs?: number;
  // Stops waiting for the reply. The worker keeps running; the caller decides whether to terminate.
  signal?: AbortSignal;
}

// One slice of a chunked call, as far as the loop needs to see it (W1.2 section 9).
interface ChunkedSlice {
  cursor: string | null;
  done: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The text a wasm or Pyodide out-of-memory failure carries in the worker's error message. The
// worker reports such a failure as text, not as a reply, so it is matched on the message (W1.2
// section 4, OUT_OF_MEMORY). A Python MemoryError inside a call arrives as a reply and needs none
// of this. "Memory access out of bounds" is left out: it is a corrupted heap, not a full one.
const OUT_OF_MEMORY_TEXT =
  /out of memory|could not allocate memory|maximum memory size exceeded|cannot enlarge memory|memoryerror|\bOOM\b/i;

export function isOutOfMemoryMessage(message: string): boolean {
  return OUT_OF_MEMORY_TEXT.test(message);
}

// A rejection of the worker channel. Out-of-memory gets its own code so the UI can offer a restart
// (W1.1 section 1); it is never restarted here, because that loses the undo history.
function workerFailure(method: string, error: unknown): RpcError {
  const message = messageOf(error);
  if (isOutOfMemoryMessage(message)) {
    return new RpcError('OUT_OF_MEMORY', `the engine ran out of memory during ${method}`, {
      method,
    });
  }
  return new RpcError('INTERNAL', `the engine worker failed: ${message}`);
}

function cancelled(method: string): RpcError {
  return new RpcError('CANCELLED', `${method} was cancelled`, { method });
}

// The deadline of a call: its class's base, plus the io class's extra per 4 MB sent (W1.2 section 10).
export function deadlineMs(method: MethodName, bytesSent: number): number {
  const base = DEADLINE_MS[METHOD_DEADLINE[method]];
  if (METHOD_DEADLINE[method] !== 'io') return base;
  return base + Math.ceil(bytesSent / IO_EXTRA.bytesPerStep) * IO_EXTRA.msPerStep;
}

// Turns a typed params value into JSON plus the buffers it names. Each binary value becomes a
// $bin marker; a buffer given here is detached by the transfer, so the caller must not reuse it.
function encodeValue(value: unknown, buffers: ArrayBuffer[], path: string): unknown {
  if (value instanceof ArrayBuffer) {
    buffers.push(value);
    return { $bin: buffers.length - 1 };
  }
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
    buffers.push(copy);
    return { $bin: buffers.length - 1 };
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RpcError('INVALID_ARGS', `${path}: not a finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => encodeValue(item, buffers, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = encodeValue(item, buffers, `${path}.${key}`);
    }
    return out;
  }
  throw new RpcError('INVALID_ARGS', `${path}: a ${typeof value} has no JSON form`);
}

// Reads one reply. Throws RpcError for an error reply and ReplyShapeError for anything that does
// not match the generated types; the caller maps the latter to INTERNAL.
function interpret<M extends MethodName>(
  method: M,
  id: number,
  result: CallResult,
): Methods[M]['result'] {
  const buffers = result.buffer === undefined ? [] : [result.buffer];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.reply);
  } catch {
    throw new ReplyShapeError('reply', 'not valid JSON');
  }
  const reply = expectObject(parsed, 'reply');

  const version = expectInteger(field(reply, 'v', 'reply'), 'reply.v');
  if (version !== PROTOCOL_VERSION) {
    throw new RpcError(
      'PROTOCOL_MISMATCH',
      `the engine speaks protocol ${version}; this app speaks ${PROTOCOL_VERSION}`,
      { engine: version, app: PROTOCOL_VERSION },
    );
  }
  if (expectInteger(field(reply, 'id', 'reply'), 'reply.id') !== id) {
    throw new ReplyShapeError('reply.id', 'does not match the request');
  }

  const ok = expectBoolean(field(reply, 'ok', 'reply'), 'reply.ok');
  if (!ok) {
    checkKeys(reply, ['v', 'id', 'ok', 'error'], 'reply');
    if (buffers.length > 0) throw new ReplyShapeError('buffers', 'an error reply has buffers');
    const error = expectObject(field(reply, 'error', 'reply'), 'reply.error');
    const code = expectOneOf(field(error, 'code', 'reply.error'), ERROR_CODES, 'reply.error.code');
    const message = expectString(field(error, 'message', 'reply.error'), 'reply.error.message');
    const details = expectObject(field(error, 'details', 'reply.error'), 'reply.error.details');
    throw new RpcError(code, message, details);
  }

  checkKeys(reply, ['v', 'id', 'ok', 'result', 'events'], 'reply');
  expectArray(field(reply, 'events', 'reply'), 'reply.events');
  const ctx = newDecodeContext(buffers);
  const value = RESULT_DECODERS[method](field(reply, 'result', 'reply'), ctx, 'result');
  for (let index = 0; index < buffers.length; index++) {
    if (!ctx.used.has(index)) {
      throw new ReplyShapeError(`buffers[${index}]`, 'buffer not referenced by the reply');
    }
  }
  return value;
}

// Every failure leaves the client as an RpcError. A reply that is not what the types say is an
// INTERNAL error with the path that failed, never a silent cast.
function toRpcError(method: string, error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof ReplyShapeError) {
    return new RpcError('INTERNAL', `invalid reply to ${method}: ${error.message}`);
  }
  return new RpcError('INTERNAL', `the engine did not answer ${method}: ${messageOf(error)}`);
}

export class RpcClient {
  private nextId = 1;

  constructor(private readonly worker: WorkerClient) {}

  // One call. Resolves with the typed result, or rejects with an RpcError.
  call<M extends MethodName>(
    method: M,
    params: Methods[M]['params'],
    options: CallOptions = {},
  ): Promise<Methods[M]['result']> {
    const signal = options.signal;
    if (signal?.aborted === true) return Promise.reject(cancelled(method));

    const buffers: ArrayBuffer[] = [];
    let wire: unknown;
    try {
      wire = encodeValue(params, buffers, 'params');
    } catch (error) {
      return Promise.reject(toRpcError(method, error));
    }
    const id = this.nextId++;
    const bytesSent = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
    const timeoutMs = options.timeoutMs ?? deadlineMs(method, bytesSent);
    const request = JSON.stringify({ v: PROTOCOL_VERSION, id, method, params: wire });

    return new Promise<Methods[M]['result']>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = (): void => settle(() => reject(cancelled(method)));
      const timer = setTimeout(
        () => settle(() => reject(new RpcTimeoutError(method, timeoutMs))),
        timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });

      this.worker.call(request, buffers).then(
        (result) =>
          settle(() => {
            try {
              resolve(interpret(method, id, result));
            } catch (error) {
              reject(toRpcError(method, error));
            }
          }),
        (error: unknown) => settle(() => reject(workerFailure(method, error))),
      );
    });
  }

  // Each slice of a chunked call until it is done (W1.2 section 9). The caller reads the slices as
  // they arrive, which is how progress is shown. Stopping the loop (break, abort) asks for no more
  // slices, so nothing is left running in the worker.
  async *chunked<M extends ChunkedMethod>(
    method: M,
    params: Omit<Methods[M]['params'], 'cursor'>,
    options: CallOptions = {},
  ): AsyncGenerator<Methods[M]['result'], void, undefined> {
    let cursor: string | null = null;
    for (;;) {
      if (options.signal?.aborted === true) throw cancelled(method);
      const slice: Methods[M]['result'] = await this.call(
        method,
        { ...params, cursor } as Methods[M]['params'],
        options,
      );
      yield slice;
      // The reply's shape was checked against the generated type, which has these fields.
      const { cursor: next, done } = slice as unknown as ChunkedSlice;
      if (done) return;
      if (next === null) {
        throw new RpcError('INTERNAL', `${method} is not done but gave no cursor`);
      }
      if (next === cursor) {
        throw new RpcError('INTERNAL', `${method} did not advance its cursor`);
      }
      cursor = next;
    }
  }
}

export function createRpcClient(worker: WorkerClient): RpcClient {
  return new RpcClient(worker);
}
