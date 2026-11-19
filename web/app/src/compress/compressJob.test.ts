import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { isSmaller, runCompress, savedPercent } from './compressJob';

const BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

function reduceReply(value: unknown): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [{ name: 'reduced.pdf', mime: 'application/pdf', data: { $bin: 0 } }],
      value,
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply), buffer: BYTES };
}

function engineAndWorker(reply: CallResult) {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j2',
        label: 'Reduce File Size',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  const worker: JobWorker = { call: vi.fn(async () => reply), terminate: vi.fn() };
  return {
    call,
    worker,
    deps: {
      engine: { call } as unknown as FileJobEngine,
      startWorker: () => worker,
      progress: createJobProgressStore({ toasts: createToastStore() }),
    },
  };
}

describe('runCompress', () => {
  it('sends the preset as the reduce_size argument and reads the sizes from the value', async () => {
    const { call, deps } = engineAndWorker(reduceReply({ before: 900, after: 300, notes: [] }));

    const result = await runCompress(deps, 'doc-9', 'lossless');

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-9',
      job: 'reduce_size',
      args: { preset: 'lossless' },
    });
    expect(result.before).toBe(900);
    expect(result.after).toBe(300);
    expect(result.file?.name).toBe('reduced.pdf');
  });

  it('rejects a reply whose value has no sizes', async () => {
    const { deps } = engineAndWorker(reduceReply({ notes: [] }));
    await expect(runCompress(deps, 'doc-9', 'ebook')).rejects.toThrow();
  });
});

describe('compress sizes', () => {
  it('counts a copy as smaller only when it is smaller than the original', () => {
    expect(isSmaller(100, 99)).toBe(true);
    expect(isSmaller(100, 100)).toBe(false);
    expect(isSmaller(100, 120)).toBe(false);
  });

  it('gives the saving in whole percent, and none when the copy is not smaller', () => {
    expect(savedPercent(2_000_000, 500_000)).toBe(75);
    expect(savedPercent(1000, 1200)).toBe(0);
    expect(savedPercent(0, 0)).toBe(0);
  });
});
