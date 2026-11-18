import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { ERROR_CODES, PROTOCOL_VERSION, type OpenParams } from './generated';
import { createRpcClient, deadlineMs, RpcError, RpcTimeoutError, type RpcClient } from './client';

interface Envelope {
  v: number;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

// What the fake worker does with one request: a reply, a failure, or silence.
type Responder = (envelope: Envelope, buffer?: ArrayBuffer) => CallResult | Error | 'silent';

// A WorkerClient stand-in. It records every request and answers with the test's responder.
class FakeWorker implements WorkerClient {
  readonly requests: { envelope: Envelope; buffer?: ArrayBuffer }[] = [];
  readonly terminate = vi.fn();
  respond: Responder = () => 'silent';

  call(request: string, buffer?: ArrayBuffer): Promise<CallResult> {
    const envelope = JSON.parse(request) as Envelope;
    this.requests.push({ envelope, buffer });
    const answer = this.respond(envelope, buffer);
    if (answer === 'silent') return new Promise<CallResult>(() => undefined);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  }

  onStage(): () => void {
    return () => undefined;
  }
}

function ok(envelope: Envelope, result: unknown, buffer?: ArrayBuffer): CallResult {
  const reply = JSON.stringify({ v: PROTOCOL_VERSION, id: envelope.id, ok: true, result });
  return buffer === undefined ? { reply } : { reply, buffer };
}

function failed(
  envelope: Envelope,
  code: string,
  message = 'the message',
  details: Record<string, unknown> = { size: 3 },
): CallResult {
  const error = { code, message, details };
  return { reply: JSON.stringify({ v: PROTOCOL_VERSION, id: envelope.id, ok: false, error }) };
}

const HELLO = { protocol: PROTOCOL_VERSION, engine: 'mupdf', platform: 'web' };
const DOC_STATE = {
  page_count: 1,
  structure_version: 0,
  dirty: false,
  busy: '',
  can_undo: false,
  can_redo: false,
  undo_label: '',
  redo_label: '',
  require_full_save: false,
};

describe('RpcClient', () => {
  let worker: FakeWorker;
  let client: RpcClient;

  beforeEach(() => {
    worker = new FakeWorker();
    client = createRpcClient(worker);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('success', () => {
    it('returns the typed result and sends the envelope', async () => {
      worker.respond = (envelope) => ok(envelope, HELLO);

      const hello = await client.call('hello', {});

      expect(hello).toEqual(HELLO);
      const [sent] = worker.requests;
      expect(sent?.envelope).toEqual({ v: PROTOCOL_VERSION, id: 1, method: 'hello', params: {} });
      expect(sent?.buffer).toBeUndefined();
    });

    it('numbers each request and matches each reply to its own id', async () => {
      worker.respond = (envelope) => ok(envelope, HELLO);
      await client.call('hello', {});
      await client.call('hello', {});
      expect(worker.requests.map((r) => r.envelope.id)).toEqual([1, 2]);
    });

    it('moves bytes as one buffer and names it with a $bin marker', async () => {
      const data = new Uint8Array([37, 80, 68, 70]).buffer;
      worker.respond = (envelope) =>
        ok(envelope, {
          handle: 'h',
          info: { encrypted: false, has_signatures: false, page_count: 1, title: '' },
          pages: 1,
          warning: null,
        });

      const params: OpenParams = { name: 'a.pdf', data, password: null };
      const opened = await client.call('session.open', params);

      expect(opened.handle).toBe('h');
      const [sent] = worker.requests;
      expect(sent?.envelope.params).toEqual({ name: 'a.pdf', data: { $bin: 0 }, password: null });
      expect(sent?.buffer).toBe(data);
    });

    it('returns a reply buffer as the ArrayBuffer its $bin marker names', async () => {
      const pixels = new Uint8Array([9, 9, 9, 9]).buffer;
      worker.respond = (envelope) =>
        ok(
          envelope,
          { width: 1, height: 1, revision: 4, format: 'rgba', pixels: { $bin: 0 } },
          pixels,
        );

      const image = await client.call('render.page', {
        handle: 'h',
        page: 0,
        revision: 4,
        scale_milli: 1000,
        rotation: 0,
        annotations: false,
      });

      expect(image.pixels).toBe(pixels);
      expect(image.revision).toBe(4);
    });

    it('passes the state of an action reply through the typed result', async () => {
      worker.respond = (envelope) =>
        ok(envelope, {
          label: 'Undo',
          executed: true,
          value: null,
          changed: null,
          state: DOC_STATE,
        });

      const run = await client.call('actions.run', {
        handle: 'h',
        name: 'page.rotate',
        args: { pages: [0] },
      });

      expect(run.state).toEqual(DOC_STATE);
      expect(run.changed).toBeNull();
    });
  });

  describe('error mapping', () => {
    it.each(ERROR_CODES)('maps the %s reply to an RpcError with that code', async (code) => {
      worker.respond = (envelope) => failed(envelope, code, `${code} happened`, { size: 7 });

      const rejected = client.call('hello', {});

      await expect(rejected).rejects.toBeInstanceOf(RpcError);
      await expect(rejected).rejects.toMatchObject({
        code,
        message: `${code} happened`,
        details: { size: 7 },
      });
    });

    it('turns a reply with an unknown code into INTERNAL', async () => {
      worker.respond = (envelope) => failed(envelope, 'NOT_A_CODE');

      await expect(client.call('hello', {})).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('reply.error.code'),
      });
    });

    it('reports a protocol mismatch as PROTOCOL_MISMATCH', async () => {
      worker.respond = (envelope) => ({
        reply: JSON.stringify({
          v: PROTOCOL_VERSION + 1,
          id: envelope.id,
          ok: true,
          result: HELLO,
        }),
      });

      await expect(client.call('hello', {})).rejects.toMatchObject({
        code: 'PROTOCOL_MISMATCH',
      });
    });

    it('turns a worker failure into INTERNAL without terminating the worker', async () => {
      worker.respond = () => new Error('the worker failed: boom');

      await expect(client.call('hello', {})).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(worker.terminate).not.toHaveBeenCalled();
    });
  });

  describe('invalid replies', () => {
    it('becomes INTERNAL, naming the field, and never a silent cast', async () => {
      worker.respond = (envelope) =>
        ok(envelope, { protocol: '1', engine: 'mupdf', platform: 'web' });

      const rejected = client.call('hello', {});

      await expect(rejected).rejects.toBeInstanceOf(RpcError);
      await expect(rejected).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('result.protocol'),
      });
    });

    it('rejects a reply with a missing field', async () => {
      worker.respond = (envelope) => ok(envelope, { protocol: 1, platform: 'web' });
      await expect(client.call('hello', {})).rejects.toMatchObject({ code: 'INTERNAL' });
    });

    it('rejects a reply whose id is not the request id', async () => {
      worker.respond = () => ({
        reply: JSON.stringify({ v: PROTOCOL_VERSION, id: 99, ok: true, result: HELLO }),
      });
      await expect(client.call('hello', {})).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('reply.id'),
      });
    });

    it('rejects a reply that is not JSON', async () => {
      worker.respond = () => ({ reply: '{not json' });
      await expect(client.call('hello', {})).rejects.toMatchObject({ code: 'INTERNAL' });
    });

    it('rejects a buffer that the reply does not name', async () => {
      worker.respond = (envelope) => ok(envelope, HELLO, new Uint8Array([1]).buffer);
      await expect(client.call('hello', {})).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('not referenced'),
      });
    });
  });

  describe('params', () => {
    it('refuses a call that would send more than one binary value', async () => {
      const extra = {
        name: 'a.pdf',
        data: new ArrayBuffer(1),
        password: null,
        more: new ArrayBuffer(1),
      };

      await expect(
        client.call('session.open', extra as unknown as OpenParams),
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      expect(worker.requests).toHaveLength(0);
    });
  });

  describe('deadlines and timeouts', () => {
    it('uses the deadline class of the call, plus the io extra per 4 MB', () => {
      expect(deadlineMs('hello', 0)).toBe(3_000);
      expect(deadlineMs('actions.run', 100 * 1024 * 1024)).toBe(30_000);
      expect(deadlineMs('session.open', 9 * 1024 * 1024)).toBe(15_000 + 3 * 1_000);
    });

    it('rejects with a typed timeout and leaves the worker running', async () => {
      vi.useFakeTimers();
      const pending = client.call('hello', {}, { timeoutMs: 100 });
      const outcome = pending.catch((error: unknown) => error);

      vi.advanceTimersByTime(100);

      const error = await outcome;
      expect(error).toBeInstanceOf(RpcTimeoutError);
      expect(error).toMatchObject({ code: 'TIMEOUT', timeoutMs: 100 });
      expect(worker.terminate).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    it('rejects with CANCELLED when the signal aborts, and does not terminate the worker', async () => {
      const controller = new AbortController();
      const pending = client.call('hello', {}, { signal: controller.signal });
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('does not send a call whose signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(client.call('hello', {}, { signal: controller.signal })).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      expect(worker.requests).toHaveLength(0);
    });
  });

  describe('chunked calls', () => {
    const extract = {
      handle: 'h',
      start: { page: 0, index: 0 },
      end: { page: 2, index: 0 },
      budget_ms: 100,
    };

    it('loops over the cursor until done, yielding each slice', async () => {
      const slices: Record<string, unknown> = {
        none: { text: 'a', cursor: 'v1:p1', pages_done: 1, total: 3, done: false },
        'v1:p1': { text: 'b', cursor: 'v1:p2', pages_done: 2, total: 3, done: false },
        'v1:p2': { text: 'c', cursor: null, pages_done: 3, total: 3, done: true },
      };
      worker.respond = (envelope) => ok(envelope, slices[String(envelope.params.cursor ?? 'none')]);

      const texts: string[] = [];
      for await (const slice of client.chunked('text.extract', extract)) {
        texts.push(slice.text);
      }

      expect(texts).toEqual(['a', 'b', 'c']);
      expect(worker.requests.map((r) => r.envelope.params.cursor)).toEqual([
        null,
        'v1:p1',
        'v1:p2',
      ]);
    });

    it('stops asking for slices when the signal aborts', async () => {
      const controller = new AbortController();
      worker.respond = (envelope) =>
        ok(envelope, { text: 'a', cursor: 'v1:p1', pages_done: 1, total: 3, done: false });

      const seen: string[] = [];
      const run = async (): Promise<void> => {
        for await (const slice of client.chunked('text.extract', extract, {
          signal: controller.signal,
        })) {
          seen.push(slice.text);
          controller.abort();
        }
      };

      await expect(run()).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(seen).toHaveLength(1);
      expect(worker.requests).toHaveLength(1);
    });

    it('fails with INTERNAL when the cursor does not advance', async () => {
      worker.respond = (envelope) =>
        ok(envelope, { text: '', cursor: 'same', pages_done: 0, total: 3, done: false });

      const run = async (): Promise<void> => {
        const slices = client.chunked('text.extract', extract);
        for await (const slice of slices) expect(slice.total).toBe(3);
      };

      await expect(run()).rejects.toMatchObject({
        code: 'INTERNAL',
        message: expect.stringContaining('did not advance'),
      });
    });
  });
});
