import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeSaveParams, RESULT_DECODERS, type MethodName, type Methods } from './generated';
import { newDecodeContext, ReplyShapeError, takeBinary, type DecodeContext } from './shape';

// The repository root. `npm test` runs from web/app, so it is two folders up from there.
const REPO_ROOT = resolve(process.cwd(), '..', '..');
if (!existsSync(join(REPO_ROOT, 'scripts', 'make_web_types.py'))) {
  throw new Error(`run the tests from web/app (the repository root is ${REPO_ROOT})`);
}
const GENERATED = join(REPO_ROOT, 'web', 'app', 'src', 'rpc', 'generated.ts');

const scratch = mkdtempSync(join(tmpdir(), 'rpc-drift-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Runs the generator's --check with the given output file. Exit code 0 means no drift.
function runCheck(output?: string): { status: number; stderr: string } {
  const args = ['run', 'python', 'scripts/make_web_types.py', '--check'];
  if (output !== undefined) args.push('--output', output);
  const result = spawnSync('uv', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
  if (result.error !== undefined) {
    throw new Error(`could not run uv (${result.error.message}); install uv to run this check`);
  }
  return { status: result.status ?? -1, stderr: result.stderr };
}

describe('generated.ts drift check (W1.2 section 14)', () => {
  it('matches what scripts/make_web_types.py writes', () => {
    const { status, stderr } = runCheck();
    expect(stderr).toBe('');
    expect(status).toBe(0);
  }, 120_000);

  it('fails on a copy whose DTO-derived content has changed', () => {
    const original = readFileSync(GENERATED, 'utf8');
    const edited = original.replace(
      'export interface HandleParams {\n  handle: string;\n',
      'export interface HandleParams {\n  handle: string;\n  extra: string;\n',
    );
    expect(edited).not.toBe(original);
    const copy = join(scratch, 'generated.ts');
    writeFileSync(copy, edited, 'utf8');
    const { status, stderr } = runCheck(copy);
    expect(status).toBe(1);
    expect(stderr).toContain('out of date');
  }, 120_000);

  it('passes on an unedited copy', () => {
    const copy = join(scratch, 'unchanged.ts');
    writeFileSync(copy, readFileSync(GENERATED, 'utf8'), 'utf8');
    expect(runCheck(copy).status).toBe(0);
  }, 120_000);
});

function ctxWith(...buffers: ArrayBuffer[]): DecodeContext {
  return newDecodeContext(buffers);
}

function decodeResult<M extends MethodName>(
  method: M,
  value: unknown,
  buffers: ArrayBuffer[] = [],
): Methods[M]['result'] {
  return RESULT_DECODERS[method](value, ctxWith(...buffers), 'result');
}

const DOC_INFO = { encrypted: false, has_signatures: false, page_count: 2, title: 'a' };
const DOC_STATE = {
  page_count: 2,
  structure_version: 1,
  dirty: false,
  busy: '',
  can_undo: false,
  can_redo: false,
  undo_label: '',
  redo_label: '',
  require_full_save: false,
};

describe('reply validators', () => {
  it('accept valid replies of a sample of calls', () => {
    expect(decodeResult('hello', { protocol: 1, engine: 'mupdf', platform: 'web' })).toEqual({
      protocol: 1,
      engine: 'mupdf',
      platform: 'web',
    });
    expect(
      decodeResult('session.open', {
        handle: 'h1',
        info: DOC_INFO,
        pages: 2,
        warning: null,
        state: DOC_STATE,
      }),
    ).toMatchObject({ handle: 'h1', pages: 2, warning: null });
    expect(
      decodeResult('session.pages', { pages: [{ width: 612, height: 792, rotation: 0 }] }),
    ).toEqual({ pages: [{ width: 612, height: 792, rotation: 0 }] });
    expect(
      decodeResult('actions.undo', { done: false, label: '', changed: null, state: DOC_STATE }),
    ).toMatchObject({ done: false, changed: null });
    expect(
      decodeResult('actions.run', {
        label: 'Rotate',
        executed: true,
        value: { anything: [1, 'two'] },
        changed: {
          changes: [{ kind: 'structure', pages: [0, 1] }],
          revisions: { '0': 3 },
        },
        state: DOC_STATE,
      }),
    ).toMatchObject({ label: 'Rotate', executed: true });
    expect(decodeResult('session.close', {})).toEqual({});
    expect(
      decodeResult('text.extract', {
        text: 'abc',
        cursor: 'v1:p2',
        pages_done: 1,
        total: 3,
        done: false,
      }),
    ).toMatchObject({ cursor: 'v1:p2', done: false });
  });

  it('resolve a $bin marker to the buffer it names', () => {
    const pixels = new Uint8Array([1, 2, 3, 4]).buffer;
    const image = decodeResult(
      'render.page',
      { width: 1, height: 1, revision: 0, format: 'rgba', pixels: { $bin: 0 } },
      [pixels],
    );
    expect(image.pixels).toBe(pixels);
    expect(image.format).toBe('rgba');
  });

  it('reject a wrong type, naming the field', () => {
    expect(() =>
      decodeResult('hello', { protocol: '1', engine: 'mupdf', platform: 'web' }),
    ).toThrow(ReplyShapeError);
    expect(() =>
      decodeResult('hello', { protocol: '1', engine: 'mupdf', platform: 'web' }),
    ).toThrow('result.protocol');
  });

  it('rejects a boolean where an integer is expected, and a fractional page count', () => {
    expect(() =>
      decodeResult('hello', { protocol: true, engine: 'mupdf', platform: 'web' }),
    ).toThrow('result.protocol');
    expect(() =>
      decodeResult('session.open', {
        handle: 'h',
        info: DOC_INFO,
        pages: 1.5,
        warning: null,
        state: DOC_STATE,
      }),
    ).toThrow('result.pages');
  });

  it('rejects a missing field', () => {
    expect(() => decodeResult('hello', { protocol: 1, platform: 'web' })).toThrow('missing field');
  });

  it('rejects an unknown field', () => {
    expect(() =>
      decodeResult('hello', { protocol: 1, engine: 'mupdf', platform: 'web', extra: 1 }),
    ).toThrow('unknown field');
  });

  it('rejects a bad nested value with its full path', () => {
    expect(() =>
      decodeResult('session.pages', { pages: [{ width: 612, height: 'tall', rotation: 0 }] }),
    ).toThrow('result.pages[0].height');
  });

  it('rejects a value outside an enum', () => {
    expect(() => decodeSaveParams({ handle: 'h', mode: 'overwrite' }, ctxWith(), 'params')).toThrow(
      ReplyShapeError,
    );
  });

  it('rejects a binary marker that is reused, missing, or malformed', () => {
    const buffer = new Uint8Array([1]).buffer;
    const ctx = ctxWith(buffer);
    expect(takeBinary({ $bin: 0 }, ctx, 'x')).toBe(buffer);
    expect(() => takeBinary({ $bin: 0 }, ctx, 'x')).toThrow('more than once');
    expect(() => takeBinary({ $bin: 1 }, ctxWith(buffer), 'x')).toThrow('missing buffer');
    expect(() => takeBinary({ $bin: -1 }, ctxWith(buffer), 'x')).toThrow('bad index');
    expect(() => takeBinary({ $bin: 0, extra: 1 }, ctxWith(buffer), 'x')).toThrow(
      'expected a binary value',
    );
  });
});
