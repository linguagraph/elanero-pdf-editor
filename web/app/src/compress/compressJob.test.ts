import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { PROTOCOL_VERSION, REDUCE_PRESETS } from '../rpc/generated';
import { ReplyShapeError } from '../rpc/shape';
import {
  auditRows,
  isSmaller,
  presetSettings,
  readAudit,
  reduceArgs,
  runCompress,
  sameSettings,
  savedPercent,
} from './compressJob';

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
      value: { audit_before: null, audit_after: null, ...(value as object) },
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

    const result = await runCompress(deps, 'doc-9', presetSettings('lossless'), { audit: false });

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-9',
      job: 'reduce_size',
      args: { preset: 'lossless', audit: false },
    });
    expect(result.before).toBe(900);
    expect(result.after).toBe(300);
    expect(result.file?.name).toBe('reduced.pdf');
    expect(result.auditBefore).toBeNull();
    expect(result.auditAfter).toBeNull();
  });

  it('sends the custom options and the audit flag to the job, and reads both audits', async () => {
    const audit = {
      total: 1000,
      categories: [{ key: 'images', name: 'Images', size: 700 }],
    };
    const value = { before: 900, after: 300, notes: [], audit_before: audit, audit_after: audit };
    const { call, worker, deps } = engineAndWorker(reduceReply(value));
    const custom = { ...presetSettings('ebook'), preset: 'custom' as const };

    const result = await runCompress(deps, 'doc-9', custom, { audit: true });

    const prepare = call.mock.calls[0] as unknown as [string, { args: unknown }] | undefined;
    expect(prepare?.[1].args).toEqual({
      preset: 'custom',
      options: REDUCE_PRESETS.ebook,
      audit: true,
    });
    const run = JSON.parse(String(vi.mocked(worker.call).mock.calls[0]?.[0])) as {
      params: { args: unknown };
    };
    expect(run.params.args).toEqual(prepare?.[1].args);
    expect(result.auditBefore).toEqual({
      total: 1000,
      categories: [{ key: 'images', size: 700 }],
    });
    expect(result.auditAfter?.total).toBe(1000);
  });

  it('rejects a reply whose value has no sizes', async () => {
    const { deps } = engineAndWorker(reduceReply({ notes: [] }));
    await expect(
      runCompress(deps, 'doc-9', presetSettings('ebook'), { audit: false }),
    ).rejects.toThrow();
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

describe('compress settings', () => {
  it('seeds a preset from the generated table, as a copy', () => {
    const settings = presetSettings('screen');
    expect(settings).toEqual({ preset: 'screen', options: REDUCE_PRESETS.screen });
    expect(settings.options).not.toBe(REDUCE_PRESETS.screen);
    expect(presetSettings('lossless').options.image_dpi).toBeNull();
  });

  it('sends only the key for a named preset, and the options for a custom one', () => {
    expect(reduceArgs(presetSettings('print'), true)).toEqual({ preset: 'print', audit: true });
    const custom = { ...presetSettings('print'), preset: 'custom' as const };
    expect(reduceArgs(custom, false)).toEqual({
      preset: 'custom',
      options: REDUCE_PRESETS.print,
      audit: false,
    });
  });

  it('tells a custom edit from its preset', () => {
    const base = presetSettings('ebook');
    expect(sameSettings(base, presetSettings('ebook'))).toBe(true);
    const edited = {
      preset: 'custom' as const,
      options: { ...base.options, jpeg_quality: 41 },
    };
    expect(sameSettings(base, edited)).toBe(false);
    expect(sameSettings(base, { ...base, preset: 'custom' })).toBe(false);
  });
});

describe('readAudit', () => {
  const valid = {
    total: 500,
    categories: [
      { key: 'images', name: 'Images', size: 300 },
      { key: 'file_overhead', name: 'File overhead', size: 200 },
    ],
  };

  it('accepts null (no audit asked for) and a valid audit, ignoring the English name', () => {
    expect(readAudit(null, 'value.audit_before')).toBeNull();
    expect(readAudit(valid, 'value.audit_before')).toEqual({
      total: 500,
      categories: [
        { key: 'images', size: 300 },
        { key: 'file_overhead', size: 200 },
      ],
    });
  });

  it('rejects a category key the front end has no text for', () => {
    const bad = { total: 1, categories: [{ key: 'mystery', name: 'Mystery', size: 1 }] };
    expect(() => readAudit(bad, 'value.audit_before')).toThrow(ReplyShapeError);
  });

  it('rejects a size that is not an integer', () => {
    const bad = { total: 1, categories: [{ key: 'images', name: 'Images', size: 1.5 }] };
    expect(() => readAudit(bad, 'value.audit_before')).toThrow(ReplyShapeError);
  });
});

describe('auditRows', () => {
  const audit = (categories: [string, number][]) =>
    ({
      total: categories.reduce((sum, [, size]) => sum + size, 0),
      categories: categories.map(([key, size]) => ({ key, size })),
    }) as Parameters<typeof auditRows>[0] & object;

  it('gives no rows when either audit is missing', () => {
    expect(auditRows(null, null)).toEqual([]);
    expect(auditRows(audit([['images', 5]]), null)).toEqual([]);
  });

  it('drops rows that are zero in both, sorts by the before size and keeps file overhead last', () => {
    const rows = auditRows(
      audit([
        ['file_overhead', 900],
        ['fonts', 100],
        ['images', 50],
        ['tags', 0],
      ]),
      audit([
        ['file_overhead', 10],
        ['fonts', 300],
        ['images', 50],
        ['tags', 0],
      ]),
    );
    expect(rows).toEqual([
      { key: 'fonts', before: 100, after: 300 },
      { key: 'images', before: 50, after: 50 },
      { key: 'file_overhead', before: 900, after: 10 },
    ]);
  });

  it('sums two engine labels that map to the same key', () => {
    const rows = auditRows(
      audit([
        ['other', 30],
        ['other', 20],
      ]),
      audit([['other', 5]]),
    );
    expect(rows).toEqual([{ key: 'other', before: 50, after: 5 }]);
  });

  it('breaks a tie in before size by the category order', () => {
    const rows = auditRows(
      audit([
        ['tags', 10],
        ['images', 10],
      ]),
      audit([
        ['tags', 10],
        ['images', 10],
      ]),
    );
    expect(rows.map((row) => row.key)).toEqual(['images', 'tags']);
  });
});
