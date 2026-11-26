import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { runSpaceUsage } from './spaceUsageJob';

const audit = {
  total: 300,
  categories: [
    { key: 'images', name: 'Images', size: 100 },
    { key: 'page_content', name: 'Page content', size: 200 },
  ],
};

// The job worker's reply for the audit: a report, with the audit as its value and no files.
function reportReply(value: unknown): CallResult {
  return {
    reply: JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: { kind: 'report', label: '', require_full_save: false, document: null, value },
      events: [],
    }),
  };
}

function setup(reply: CallResult) {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'Space Usage',
        mutating: false,
        document: new ArrayBuffer(4),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  const worker: JobWorker = { call: vi.fn(async () => reply), terminate: vi.fn() };
  const deps = {
    engine: { call } as unknown as FileJobEngine,
    startWorker: () => worker,
    progress: createJobProgressStore({ toasts: createToastStore() }),
    ownToasts: true,
  };
  return { call, deps };
}

describe('runSpaceUsage', () => {
  it('runs the audit job with no arguments and reads its report', async () => {
    const { call, deps } = setup(reportReply(audit));
    const result = await runSpaceUsage(deps, 'doc-1');

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'audit',
      args: {},
    });
    expect(result).toEqual({
      total: 300,
      categories: [
        { key: 'images', size: 100 },
        { key: 'page_content', size: 200 },
      ],
    });
  });

  it('refuses a files reply, since the audit returns a report', async () => {
    const files = {
      reply: JSON.stringify({
        v: PROTOCOL_VERSION,
        id: 1,
        ok: true,
        result: { kind: 'files', label: '', value: audit, files: [] },
        events: [],
      }),
    };
    const { deps } = setup(files);
    await expect(runSpaceUsage(deps, 'doc-1')).rejects.toThrow();
  });
});
