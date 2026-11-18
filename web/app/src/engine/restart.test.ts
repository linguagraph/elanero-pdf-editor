import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkerClient } from './start';
import { LOST_WORK, restartEngine, type OpenDocumentRef } from './restart';

// A Worker stand-in: records its URL and lets the test see whether it was terminated.
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  postMessage(): void {
    // The start path posts an init message; nothing answers it here.
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
}

// The client the app had before the engine stopped answering; its calls never settle.
function staleClient(): WorkerClient & { terminate: Mock } {
  return {
    call: () => new Promise(() => undefined),
    onStage: () => () => undefined,
    terminate: vi.fn(),
  };
}

const ORIGIN = globalThis.location.origin;
const START = { workerUrl: `${ORIGIN}/assets/engine.worker.js`, assetBaseUrl: `${ORIGIN}/engine/` };
const DOCS: OpenDocumentRef[] = [
  { id: 'd1', name: 'contract.pdf' },
  { id: 'd2', name: 'notes.pdf' },
  { id: 'd3', name: 'scan.pdf' },
];

const createObjectURL = vi.fn(() => `blob:${ORIGIN}/fake`);
const revokeObjectURL = vi.fn();

beforeEach(() => {
  FakeWorker.instances = [];
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('Worker', FakeWorker);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('restartEngine', () => {
  it('starts a new engine worker and terminates the old one', () => {
    const old = staleClient();

    const result = restartEngine({ current: old, start: START, documents: DOCS });

    expect(result.ok).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.url).toMatch(/^blob:/);
    expect(old.terminate).toHaveBeenCalledTimes(1);
    if (result.ok) expect(result.worker).toBeDefined();
  });

  it('reports what is lost: the changes since the last autosave and the undo history', () => {
    const result = restartEngine({ current: staleClient(), start: START, documents: DOCS });

    if (!result.ok) throw new Error('the restart should have started');
    expect(result.lost).toBe(LOST_WORK);
    expect(result.lost.text).toContain('since the last autosave');
    expect(result.lost.text).toContain('undo history');
    expect(result.lost.items).toEqual([
      'the changes made since the last autosave',
      'the undo history',
    ]);
  });

  it('lists the documents to reopen in the order the caller gave', () => {
    const result = restartEngine({ current: staleClient(), start: START, documents: DOCS });

    if (!result.ok) throw new Error('the restart should have started');
    expect(result.reopen).toEqual(DOCS);
    expect(result.reopen.map((doc) => doc.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('lists no documents when none were open', () => {
    const result = restartEngine({ current: staleClient(), start: START, documents: [] });

    if (!result.ok) throw new Error('the restart should have started');
    expect(result.reopen).toEqual([]);
  });

  it('returns a typed error when the new worker cannot start, and leaves the old one running', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Workers are blocked by this page');
        }
      },
    );
    const old = staleClient();

    const result = restartEngine({ current: old, start: START, documents: DOCS });

    expect(result).toEqual({
      ok: false,
      code: 'ENGINE_START_FAILED',
      message: 'Workers are blocked by this page',
    });
    expect(old.terminate).not.toHaveBeenCalled();
  });

  it('returns a typed error for a worker URL on another origin, and touches nothing', () => {
    const old = staleClient();

    const result = restartEngine({
      current: old,
      start: {
        workerUrl: 'https://elsewhere.example/engine.worker.js',
        assetBaseUrl: START.assetBaseUrl,
      },
      documents: DOCS,
    });

    expect(result.ok).toBe(false);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(old.terminate).not.toHaveBeenCalled();
  });
});
