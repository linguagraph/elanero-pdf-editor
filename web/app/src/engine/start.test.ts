import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallError, EngineLoadError } from './errors';
import { startEngine, startJobWorker } from './start';

type Listener = (event: unknown) => void;

// A Worker stand-in that records what it was given and lets the test emit messages.
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: { message: unknown; transfer?: Transferable[] }[] = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const ORIGIN = globalThis.location.origin;
const WORKER_URL = `${ORIGIN}/assets/engine.worker.js`;
const ASSETS = `${ORIGIN}/engine/`;

// jsdom's Blob has no stream() or text(), so read it with FileReader.
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

let blobs: Blob[] = [];
const createObjectURL = vi.fn((blob: Blob) => {
  blobs.push(blob);
  return `blob:${ORIGIN}/fake-${blobs.length}`;
});
const revokeObjectURL = vi.fn();

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  if (worker === undefined) throw new Error('no worker was created');
  return worker;
}

beforeEach(() => {
  FakeWorker.instances = [];
  blobs = [];
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('Worker', FakeWorker);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startEngine', () => {
  it('creates a module worker from a blob URL that imports the absolute worker URL', async () => {
    startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();

    expect(worker.url).toMatch(/^blob:/);
    expect(worker.options).toEqual({ type: 'module' });
    expect(blobs).toHaveLength(1);
    expect(await readBlobText(blobs[0] as Blob)).toBe(`import "${WORKER_URL}";`);
  });

  it('sends the init message with the asset base URL before any call', () => {
    startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    expect(latestWorker().posted[0]?.message).toEqual({ kind: 'init', baseUrl: ASSETS });
  });

  it('rejects a worker URL on another origin before creating anything', () => {
    expect(() =>
      startEngine({ workerUrl: 'https://example.invalid/x.js', assetBaseUrl: ASSETS }),
    ).toThrow(/not on this origin/);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('resolves each call with the reply that has the matching id', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();

    const first = client.call('{"a":1}');
    const second = client.call('{"a":2}');
    const firstId = (worker.posted[1]?.message as { id: number }).id;
    const secondId = (worker.posted[2]?.message as { id: number }).id;

    worker.emit('message', { data: { id: secondId, reply: 'two' } });
    worker.emit('message', { data: { id: firstId, reply: 'one' } });

    await expect(first).resolves.toEqual({ reply: 'one' });
    await expect(second).resolves.toEqual({ reply: 'two' });
  });

  it('transfers the buffer with the call and returns the reply buffer', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const input = new Uint8Array([1]).buffer;
    const output = new Uint8Array([2, 3]).buffer;

    const pending = client.call('{}', [input]);
    const sent = worker.posted[1];
    expect(sent?.transfer).toEqual([input]);
    expect((sent?.message as { buffers?: unknown }).buffers).toEqual([input]);
    const id = (sent?.message as { id: number }).id;
    worker.emit('message', { data: { id, reply: 'ok', buffer: output } });

    await expect(pending).resolves.toEqual({ reply: 'ok', buffer: output });
  });

  it('routes each notice to the call it belongs to', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    client.call('{"a":1}', [], onFirst);
    client.call('{"a":2}', [], onSecond);
    const secondId = (worker.posted[2]?.message as { id: number }).id;
    const notice = { notice: 'progress', id: 1, data: { done: 1, total: 2, status: '' } };

    worker.emit('message', { data: { kind: 'notice', id: secondId, notice } });

    expect(onSecond).toHaveBeenCalledWith(notice);
    expect(onFirst).not.toHaveBeenCalled();
  });

  it('drops a notice that arrives after its call has finished', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const onNotice = vi.fn();
    const pending = client.call('{"a":1}', [], onNotice);
    const id = (worker.posted[1]?.message as { id: number }).id;
    worker.emit('message', { data: { id, reply: 'done' } });
    await expect(pending).resolves.toEqual({ reply: 'done' });

    worker.emit('message', { data: { kind: 'notice', id, notice: { notice: 'progress' } } });

    expect(onNotice).not.toHaveBeenCalled();
  });

  it('resolves a list reply with its buffers, and buffer is the first', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const first = new Uint8Array([1]).buffer;
    const second = new Uint8Array([2, 3]).buffer;
    const pending = client.call('{}');
    const id = (worker.posted[1]?.message as { id: number }).id;
    worker.emit('message', { data: { id, reply: 'ok', buffers: [first, second] } });

    await expect(pending).resolves.toEqual({
      reply: 'ok',
      buffers: [first, second],
      buffer: first,
    });
  });

  it('rejects with CallError on an error reply', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const pending = client.call('{}');
    const id = (worker.posted[1]?.message as { id: number }).id;
    worker.emit('message', { data: { id, error: { message: 'bad request' } } });

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CallError);
    expect((error as Error).message).toBe('bad request');
  });

  it('rejects with EngineLoadError when the error reply carries a stage', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const pending = client.call('{}');
    const id = (worker.posted[1]?.message as { id: number }).id;
    worker.emit('message', { data: { id, error: { message: 'no zip', stage: 'packages' } } });

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).stage).toBe('packages');
  });

  it('forwards stage events to subscribers until they unsubscribe', () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const seen: string[] = [];
    const stop = client.onStage((stage) => seen.push(stage));

    worker.emit('message', { data: { kind: 'stage', stage: 'pyodide' } });
    stop();
    worker.emit('message', { data: { kind: 'stage', stage: 'ready' } });

    expect(seen).toEqual(['pyodide']);
  });

  it('terminate stops the worker, revokes the blob and fails pending calls', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const pending = client.call('{}');

    client.terminate();
    client.terminate(); // a second call does nothing

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(worker.url);
    await expect(pending).rejects.toBeInstanceOf(CallError);
    await expect(client.call('{}')).rejects.toThrow(/terminated/);
  });

  it('fails pending calls when the worker reports an error', async () => {
    const client = startEngine({ workerUrl: WORKER_URL, assetBaseUrl: ASSETS });
    const worker = latestWorker();
    const pending = client.call('{}');

    worker.emit('error', { message: 'boom' });

    await expect(pending).rejects.toThrow(/boom/);
  });
});

describe('startJobWorker', () => {
  it('creates its own worker only when asked', () => {
    expect(FakeWorker.instances).toHaveLength(0);
    startJobWorker({ workerUrl: `${ORIGIN}/assets/jobworker.js`, assetBaseUrl: ASSETS });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(blobs).toHaveLength(1);
  });
});
