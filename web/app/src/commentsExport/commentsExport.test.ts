import { describe, expect, it, vi } from 'vitest';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { PROTOCOL_VERSION } from '../rpc/generated';
import {
  COMMENTS_EXPORT_JOB,
  commentsExportArgs,
  commentsExportFileName,
  runCommentsExport,
} from './commentsExport';

const BYTES = new Uint8Array([60, 120, 102, 100, 102]).buffer;

function filesWorker(name: string, mime: string): JobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: { kind: 'files', files: [{ name, mime, data: { $bin: 0 } }], value: null },
    events: [],
  };
  return {
    call: vi.fn(async () => ({ reply: JSON.stringify(reply), buffer: BYTES.slice(0) })),
    terminate: vi.fn(),
  };
}

function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'comments.export',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: true, state: {} };
  });
  return { call };
}

describe('comment export job', () => {
  it('names the job and passes the format and the document name', () => {
    expect(COMMENTS_EXPORT_JOB).toBe('comments_export');
    expect(commentsExportArgs('csv', 'Report.pdf')).toEqual({ format: 'csv', name: 'Report.pdf' });
  });

  it('previews the file name for each format from the stem', () => {
    expect(commentsExportFileName('xfdf', 'Report.pdf')).toBe('Report.xfdf');
    expect(commentsExportFileName('csv', 'Report.pdf')).toBe('Report-comments.csv');
    expect(commentsExportFileName('pdf', 'Report.pdf')).toBe('Report-comments.pdf');
    expect(commentsExportFileName('xfdf', '')).toBe('document.xfdf');
    expect(commentsExportFileName('xfdf', 'a/b.pdf')).toBe('a_b.xfdf');
  });

  it('runs the comments_export job and returns its file', async () => {
    const engine = fakeEngine();
    const files = await runCommentsExport(
      {
        engine: engine as unknown as FileJobEngine,
        startWorker: () => filesWorker('Report-comments.csv', 'text/csv'),
      },
      'h1',
      'csv',
      'Report.pdf',
    );
    expect(engine.call).toHaveBeenCalledWith(
      'jobs.prepare',
      expect.objectContaining({
        handle: 'h1',
        job: 'comments_export',
        args: { format: 'csv', name: 'Report.pdf' },
      }),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('Report-comments.csv');
    expect(files[0]?.mime).toBe('text/csv');
  });
});
