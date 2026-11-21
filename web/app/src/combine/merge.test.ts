import { describe, expect, it } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { RpcError } from '../rpc/client';
import { runMergeJob } from './merge';

// A job worker stand-in: it records each request and answers with the test's reply.
class FakeJobWorker implements WorkerClient {
  readonly calls: { request: string; buffers: readonly ArrayBuffer[] }[] = [];
  answer: CallResult = { reply: '{}' };

  call(request: string, buffers: readonly ArrayBuffer[] = []): Promise<CallResult> {
    this.calls.push({ request, buffers });
    return Promise.resolve(this.answer);
  }

  onStage(): () => void {
    return () => undefined;
  }

  terminate(): void {
    // Not used by these tests.
  }
}

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function okReply(output: ArrayBuffer): CallResult {
  const reply = {
    v: 1,
    id: 1,
    ok: true,
    result: {
      kind: 'new_document',
      label: '',
      require_full_save: false,
      document: { $bin: 0 },
      files: [],
      value: null,
      name: 'merged.pdf',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply), buffer: output };
}

describe('runMergeJob', () => {
  it('sends job.run with the sources in order, each as its own $bin value', async () => {
    const worker = new FakeJobWorker();
    worker.answer = okReply(bytes(9));
    const first = bytes(1, 2);
    const second = bytes(3);

    await runMergeJob(worker, [
      { name: 'a.pdf', data: first },
      { name: 'b.png', data: second },
    ]);

    const [call] = worker.calls;
    const envelope = JSON.parse(call?.request ?? '{}') as Record<string, unknown>;
    expect(envelope).toEqual({
      v: 1,
      id: 1,
      method: 'job.run',
      params: {
        job: 'merge',
        args: {
          sources: [
            { name: 'a.pdf', data: { $bin: 0 } },
            { name: 'b.png', data: { $bin: 1 } },
          ],
          bookmarks: true,
        },
      },
    });
    expect(call?.buffers).toEqual([first, second]);
  });

  it('returns the merged bytes and the result name', async () => {
    const worker = new FakeJobWorker();
    const output = bytes(7, 7, 7);
    worker.answer = okReply(output);

    const merged = await runMergeJob(worker, [{ name: 'a.pdf', data: bytes(1) }]);

    expect(merged).toEqual({ name: 'merged.pdf', bytes: output });
  });

  it('turns an error reply into an RpcError with the code and details', async () => {
    const worker = new FakeJobWorker();
    worker.answer = {
      reply: JSON.stringify({
        v: 1,
        id: 1,
        ok: false,
        error: {
          code: 'REFUSED',
          message: 'a source is encrypted',
          details: { reason: 'encrypted_source' },
        },
      }),
    };

    const error = await runMergeJob(worker, [{ name: 'a.pdf', data: bytes(1) }]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: 'REFUSED', details: { reason: 'encrypted_source' } });
  });

  it('maps an unknown error code to INTERNAL', async () => {
    const worker = new FakeJobWorker();
    worker.answer = {
      reply: JSON.stringify({
        v: 1,
        id: 1,
        ok: false,
        error: { code: 'NOT_A_CODE', message: 'x', details: {} },
      }),
    };

    const error = await runMergeJob(worker, [{ name: 'a.pdf', data: bytes(1) }]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'INTERNAL' });
  });

  it('refuses a reply that is not a new document', async () => {
    const worker = new FakeJobWorker();
    worker.answer = {
      reply: JSON.stringify({
        v: 1,
        id: 1,
        ok: true,
        result: { kind: 'files', files: [] },
        events: [],
      }),
    };

    const error = await runMergeJob(worker, [{ name: 'a.pdf', data: bytes(1) }]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'INTERNAL' });
  });
});

describe('runMergeJob page ranges', () => {
  it('sends a ranges field only for the sources that have one', async () => {
    const worker = new FakeJobWorker();
    worker.answer = okReply(bytes(9));

    await runMergeJob(worker, [
      { name: 'a.pdf', data: bytes(1), ranges: '2-3' },
      { name: 'b.pdf', data: bytes(2) },
    ]);

    const request = JSON.parse(worker.calls[0]?.request ?? '{}') as {
      params: { args: { sources: unknown[] } };
    };
    expect(request.params.args.sources).toEqual([
      { name: 'a.pdf', data: { $bin: 0 }, ranges: '2-3' },
      { name: 'b.pdf', data: { $bin: 1 } },
    ]);
  });
});
