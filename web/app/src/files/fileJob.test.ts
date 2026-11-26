import { describe, expect, it } from 'vitest';
import type { CallResult, Notice } from '../engine/loader';
import { progressPercent } from '../feedback/jobRun';
import { RpcError } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { ReplyShapeError } from '../rpc/shape';
import { readFileJobOutput } from './fileJob';

const progress = (data: unknown): Notice => ({ notice: 'progress', id: 1, data }) as Notice;

describe('progressPercent', () => {
  it('gives the share of the total that is done, rounded', () => {
    expect(progressPercent(progress({ done: 1, total: 4, status: '' }))).toBe(25);
    expect(progressPercent(progress({ done: 1, total: 3, status: '' }))).toBe(33);
    expect(progressPercent(progress({ done: 3, total: 3, status: '' }))).toBe(100);
  });

  it('ignores a total of zero or less', () => {
    expect(progressPercent(progress({ done: 0, total: 0, status: '' }))).toBeUndefined();
    expect(progressPercent(progress({ done: 1, total: -2, status: '' }))).toBeUndefined();
  });

  it('ignores a value that is not a number', () => {
    expect(progressPercent(progress({ done: '1', total: 2, status: '' }))).toBeUndefined();
    expect(progressPercent(progress({ done: 1, status: '' }))).toBeUndefined();
    expect(progressPercent(progress({ done: 1, total: null, status: '' }))).toBeUndefined();
  });

  it('ignores a notice that is not progress, or has no data object', () => {
    expect(
      progressPercent({ notice: 'partial', id: 1, data: { done: 1, total: 2 } }),
    ).toBeUndefined();
    expect(progressPercent({ notice: 'progress', id: 1 })).toBeUndefined();
    expect(progressPercent(progress(null))).toBeUndefined();
    expect(progressPercent(progress('1 of 2'))).toBeUndefined();
  });

  it('clamps to 0 and 100', () => {
    expect(progressPercent(progress({ done: 5, total: 2, status: '' }))).toBe(100);
    expect(progressPercent(progress({ done: -1, total: 2, status: '' }))).toBe(0);
  });
});

// A job worker reply with the given result kind; the extra fields are the files, when it has any.
function jobReply(kind: string, extra: Record<string, unknown> = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: { kind, value: { total: 3 }, ...extra },
    events: [],
  };
}

describe('readFileJobOutput (result kinds)', () => {
  const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
  const filesReply = (): CallResult => ({
    reply: JSON.stringify(
      jobReply('files', {
        files: [{ name: 'a.pdf', mime: 'application/pdf', data: { $bin: 0 } }],
      }),
    ),
    buffers: [bytes],
  });

  it('reads a report reply with no files and the job value', () => {
    const reply: CallResult = { reply: JSON.stringify(jobReply('report')) };
    expect(readFileJobOutput(reply, 'audit', 'report')).toEqual({
      files: [],
      value: { total: 3 },
    });
  });

  it('refuses a report reply when files are expected', () => {
    const reply: CallResult = { reply: JSON.stringify(jobReply('report')) };
    expect(() => readFileJobOutput(reply, 'reduce_size')).toThrow(ReplyShapeError);
  });

  it('refuses a report reply that carries files', () => {
    const reply: CallResult = {
      reply: JSON.stringify(
        jobReply('report', {
          files: [{ name: 'a.pdf', mime: 'application/pdf', data: { $bin: 0 } }],
        }),
      ),
      buffers: [bytes],
    };
    expect(() => readFileJobOutput(reply, 'audit', 'report')).toThrow(ReplyShapeError);
  });

  it('refuses a files reply when a report is expected', () => {
    expect(() => readFileJobOutput(filesReply(), 'audit', 'report')).toThrow(ReplyShapeError);
  });

  it('still reads a files reply by default', () => {
    const output = readFileJobOutput(filesReply(), 'split');
    expect(output.files.map((file) => file.name)).toEqual(['a.pdf']);
    expect(output.files[0]?.data).toBe(bytes);
  });

  it('throws the engine error for an error reply, whatever the kind', () => {
    const reply: CallResult = {
      reply: JSON.stringify({
        v: PROTOCOL_VERSION,
        id: 1,
        ok: false,
        error: { code: 'INTERNAL', message: 'boom' },
        events: [],
      }),
    };
    expect(() => readFileJobOutput(reply, 'audit', 'report')).toThrow(RpcError);
  });
});
