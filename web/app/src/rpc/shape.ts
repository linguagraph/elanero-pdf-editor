// Shape checks for replies from the engine worker (W1.2 sections 5 and 6). The generated decoders
// in generated.ts are built from these few functions, so the app carries no schema library.
//
// Every check throws ReplyShapeError with the path of the value it rejected. The client turns that
// into an INTERNAL error: a reply that doesn't match the generated types is a bug or version skew,
// never something to cast through.

// Binary values of one reply. A $bin marker names an index into the reply's buffers; each buffer is
// used once, and the client checks that none is left over.
export interface DecodeContext {
  readonly buffers: readonly ArrayBuffer[];
  readonly used: Set<number>;
}

export type Decoder<T> = (value: unknown, ctx: DecodeContext, path: string) => T;

export class ReplyShapeError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ReplyShapeError';
    this.path = path;
  }
}

export function newDecodeContext(buffers: readonly ArrayBuffer[]): DecodeContext {
  return { buffers, used: new Set<number>() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ReplyShapeError(path, 'expected true or false');
  return value;
}

export function expectInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ReplyShapeError(path, 'expected a safe integer');
  }
  return value;
}

export function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReplyShapeError(path, 'expected a finite number');
  }
  return value;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ReplyShapeError(path, 'expected a string');
  return value;
}

export function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReplyShapeError(path, 'expected an object');
  return value;
}

// Rejects a key the type does not have: a reply from another build, or a bug.
export function checkKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new ReplyShapeError(`${path}.${key}`, 'unknown field');
  }
}

// A field the type requires. A missing field is named; a null one is the decoder's business.
export function field(object: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    throw new ReplyShapeError(`${path}.${key}`, 'missing field');
  }
  return object[key];
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ReplyShapeError(path, 'expected an array');
  return value;
}

export function expectOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ReplyShapeError(path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

// X | null: null passes through, anything else goes to the decoder of X.
export function orNull<T>(
  value: unknown,
  path: string,
  decode: (value: unknown, path: string) => T,
): T | null {
  return value === null ? null : decode(value, path);
}

export function decodeRecord<T>(
  value: unknown,
  path: string,
  decode: (value: unknown, path: string) => T,
): Record<string, T> {
  const object = expectObject(value, path);
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(object)) {
    out[key] = decode(item, `${path}.${key}`);
  }
  return out;
}

// A $bin marker ({"$bin": i}) becomes the buffer it names. Anything else is a shape error.
export function takeBinary(value: unknown, ctx: DecodeContext, path: string): ArrayBuffer {
  const object = expectObject(value, path);
  const keys = Object.keys(object);
  if (keys.length !== 1 || keys[0] !== '$bin') {
    throw new ReplyShapeError(path, 'expected a binary value');
  }
  const index = object.$bin;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new ReplyShapeError(path, 'binary value has a bad index');
  }
  const buffer = ctx.buffers[index];
  if (buffer === undefined)
    throw new ReplyShapeError(path, 'binary value refers to a missing buffer');
  if (ctx.used.has(index)) {
    throw new ReplyShapeError(path, 'binary buffer referenced more than once');
  }
  ctx.used.add(index);
  return buffer;
}

// An `object`-typed value (the action's own result, W1.2 section 6). It is passed on as data, with
// any $bin markers inside it resolved the same way as a typed binary field.
export function decodeJsonValue(value: unknown, ctx: DecodeContext, path: string): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return expectNumber(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => decodeJsonValue(item, ctx, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 1 && '$bin' in value) return takeBinary(value, ctx, path);
    return decodeRecord(value, path, (item, itemPath) => decodeJsonValue(item, ctx, itemPath));
  }
  throw new ReplyShapeError(path, 'not a JSON value');
}
