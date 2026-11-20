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
  type PageImage,
  type RpcEvent,
} from './generated';
import { decodeEvents } from './events';
import {
  checkKeys,
  expectBoolean,
  expectInteger,
  expectObject,
  expectOneOf,
  expectString,
  field,
  newDecodeContext,
  ReplyShapeError,
} from './shape';

// The render calls answer with a page image (W5.1b S5). When the worker could make an ImageBitmap,
// the reply's pixels are empty, its format is 'bitmap', and bitmap holds the page drawn.
export type RenderMethod = 'render.page' | 'render.tile';
export type RenderReply = PageImage & { bitmap?: ImageBitmap };
export type CallValue<M extends MethodName> = M extends RenderMethod
  ? RenderReply
  : Methods[M]['result'];

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

// What a reply says: the change events it carries, and the typed result or the error that ends the
// call. The events are published whatever the outcome (W1.2 sections 2 and 7).
type Outcome<M extends MethodName> =
  { ok: true; value: CallValue<M> } | { ok: false; error: RpcError };

interface Reading<M extends MethodName> {
  events: RpcEvent[];
  outcome: Outcome<M>;
}

function decodeSuccess<M extends MethodName>(
  method: M,
  reply: Record<string, unknown>,
  buffers: ArrayBuffer[],
): CallValue<M> {
  const ctx = newDecodeContext(buffers);
  const value = RESULT_DECODERS[method](field(reply, 'result', 'reply'), ctx, 'result');
  for (let index = 0; index < buffers.length; index++) {
    if (!ctx.used.has(index)) {
      throw new ReplyShapeError(`buffers[${index}]`, 'buffer not referenced by the reply');
    }
  }
  return value as CallValue<M>;
}

// Attaches the bitmap a worker sent with the reply, or releases it when the reply cannot use it. A
// bitmap is valid only with a render reply that says so, and a bitmap reply needs its bitmap.
function adoptBitmap<M extends MethodName>(
  method: M,
  outcome: Outcome<M>,
  bitmap: ImageBitmap | undefined,
): Outcome<M> {
  const isRender = (RENDER_METHODS as readonly string[]).includes(method);
  const format = outcome.ok ? (outcome.value as { format?: unknown }).format : undefined;
  if (bitmap === undefined) {
    if (outcome.ok && isRender && format === 'bitmap') {
      return {
        ok: false,
        error: new RpcError('INTERNAL', `invalid reply to ${method}: no bitmap came with it`),
      };
    }
    return outcome;
  }
  if (outcome.ok && isRender && format === 'bitmap') {
    return { ok: true, value: { ...(outcome.value as PageImage), bitmap } as CallValue<M> };
  }
  bitmap.close();
  if (!outcome.ok) return outcome;
  return {
    ok: false,
    error: new RpcError(
      'INTERNAL',
      `invalid reply to ${method}: a bitmap came with a non-bitmap reply`,
    ),
  };
}

function decodeFailure(reply: Record<string, unknown>, buffers: ArrayBuffer[]): RpcError {
  if (buffers.length > 0) throw new ReplyShapeError('buffers', 'an error reply has buffers');
  const error = expectObject(field(reply, 'error', 'reply'), 'reply.error');
  const code = expectOneOf(field(error, 'code', 'reply.error'), ERROR_CODES, 'reply.error.code');
  const message = expectString(field(error, 'message', 'reply.error'), 'reply.error.message');
  const details = expectObject(field(error, 'details', 'reply.error'), 'reply.error.details');
  return new RpcError(code, message, details);
}

// Reads one reply. Throws RpcError for a reply that names a bad envelope and ReplyShapeError for
// anything that does not match the generated types; both come with no events, because the events
// are only trusted once the envelope is. Once the events have decoded, a bad result or error still
// keeps them, and the call fails with INTERNAL.
function interpret<M extends MethodName>(method: M, id: number, result: CallResult): Reading<M> {
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
  checkKeys(
    reply,
    ok ? ['v', 'id', 'ok', 'result', 'events'] : ['v', 'id', 'ok', 'error', 'events'],
    'reply',
  );
  // An invalid event fails the whole reply (a ReplyShapeError), so none of its events is published.
  const events = decodeEvents(
    field(reply, 'events', 'reply'),
    newDecodeContext([]),
    'reply.events',
  );
  try {
    const outcome = ok
      ? { ok: true as const, value: decodeSuccess(method, reply, buffers) }
      : { ok: false as const, error: decodeFailure(reply, buffers) };
    return { events, outcome };
  } catch (error) {
    return { events, outcome: { ok: false, error: toRpcError(method, error) } };
  }
}

// interpret, with a bad envelope or event list turned into the call's INTERNAL error (no events).
function readReply<M extends MethodName>(method: M, id: number, result: CallResult): Reading<M> {
  try {
    return interpret(method, id, result);
  } catch (error) {
    return { events: [], outcome: { ok: false, error: toRpcError(method, error) } };
  }
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

const RENDER_METHODS: readonly RenderMethod[] = ['render.page', 'render.tile'];

// A listener of change events (W1.2 section 7): called with the events of one reply, in order.
export type RpcEventListener = (events: readonly RpcEvent[]) => void;

export class RpcClient {
  private nextId = 1;
  private readonly listeners = new Set<RpcEventListener>();

  constructor(private readonly worker: WorkerClient) {}

  // Adds a listener of change events. Returns the function that removes it. Events of a reply reach
  // the listeners before that call's promise settles, on success and on failure, and also when the
  // reply comes after the call timed out or was aborted.
  subscribe(listener: RpcEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // A listener that throws is logged and skipped: the call and the other listeners are unaffected.
  private publish(events: readonly RpcEvent[]): void {
    if (events.length === 0) return;
    // A copy, so a listener that subscribes or unsubscribes while the events go out is safe.
    for (const listener of [...this.listeners]) {
      try {
        listener(events);
      } catch (error) {
        console.error(`an RPC event listener failed: ${messageOf(error)}`);
      }
    }
  }

  // One call. Resolves with the typed result, or rejects with an RpcError.
  call<M extends MethodName>(
    method: M,
    params: Methods[M]['params'],
    options: CallOptions = {},
  ): Promise<CallValue<M>> {
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

    return new Promise<CallValue<M>>((resolve, reject) => {
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
        (result) => {
          // Read and published before settle: a reply that arrives after the timeout or abort
          // still delivers its events, though its result is dropped.
          const reading = readReply(method, id, result);
          this.publish(reading.events);
          const outcome = adoptBitmap(method, reading.outcome, result.bitmap);
          let delivered = false;
          settle(() => {
            delivered = true;
            if (outcome.ok) resolve(outcome.value);
            else reject(outcome.error);
          });
          // A bitmap whose call has already timed out or been aborted has no caller left.
          if (!delivered && outcome.ok) {
            (outcome.value as { bitmap?: ImageBitmap }).bitmap?.close();
          }
        },
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
      const slice = (await this.call(
        method,
        { ...params, cursor } as Methods[M]['params'],
        options,
      )) as Methods[M]['result'];
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
