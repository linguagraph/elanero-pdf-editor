import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import type { AutosaveDocument, AutosaveWarning } from './autosaver';
import {
  AUTOSAVE_INTERVAL_MS,
  BUSY_RETRY_MS,
  createAutosaver,
  ERROR_RETRY_MS,
  watchPageShow,
} from './autosaver';
import type { AutosaveMeta, AutosaveStore, WriteOutcome } from './autosaveStore';

type Reply = { data: ArrayBuffer; size: number; skipped: string | null };

// A store that records what the scheduler asks of it. The outcome of each write is set by the test.
function fakeStore(options: { available?: boolean; outcome?: WriteOutcome } = {}) {
  const writes: { tabId: string; docId: number; meta: AutosaveMeta }[] = [];
  const removes: { tabId: string; docId: number }[] = [];
  const removedTabs: string[] = [];
  const store: AutosaveStore = {
    available: async () => options.available ?? true,
    write: async (tabId, docId, _bytes, meta) => {
      writes.push({ tabId, docId, meta });
      return options.outcome ?? 'written';
    },
    read: async () => undefined,
    remove: async (tabId, docId) => {
      removes.push({ tabId, docId });
    },
    removeTab: async (tabId) => {
      removedTabs.push(tabId);
    },
  };
  return { store, writes, removes, removedTabs };
}

function reply(skipped: string | null = null): Reply {
  return { data: new ArrayBuffer(4), size: 4, skipped };
}

function doc(overrides: Partial<AutosaveDocument> = {}): AutosaveDocument {
  return {
    id: 1,
    name: 'report.pdf',
    handle: 'doc-1',
    pages: 3,
    dirty: true,
    ...overrides,
  };
}

// The engine calls the test answers. The default answer is a copy; a test can replace it per call.
function fakeClient(answer: (call: number) => Promise<Reply>) {
  let calls = 0;
  const call = vi.fn(async (method: string, params: unknown) => {
    if (typeof params !== 'object' || params === null) throw new Error('no params');
    if (method !== 'save.autosave_bytes') throw new Error(`unexpected ${method}`);
    calls += 1;
    return answer(calls);
  });
  return { call, client: () => ({ call }) as unknown as Pick<EngineClient, 'call'> };
}

function setup(
  options: {
    store?: Parameters<typeof fakeStore>[0];
    answer?: (call: number) => Promise<Reply>;
    client?: boolean;
  } = {},
) {
  const { store, writes, removes, removedTabs } = fakeStore(options.store);
  const engine = fakeClient(options.answer ?? (async () => reply()));
  const warnings: AutosaveWarning[] = [];
  const autosaver = createAutosaver({
    tabId: 'tab-a',
    store,
    client: () => (options.client === false ? undefined : engine.client()),
    warn: (warning) => warnings.push(warning),
  });
  return { autosaver, writes, removes, removedTabs, warnings, call: engine.call };
}

// Lets the timers and the promise chain run for a while. Each minute of the copy schedule is one
// step, so a test reads as "after N seconds".
// A zero-delay timer only fires once time moves on, so the first copy runs after a short settle.
const SETTLE_MS = 10;

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('autosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes no call and no write for a clean document', async () => {
    const { autosaver, call, writes } = setup();
    autosaver.sync([doc({ dirty: false })]);
    await advance(AUTOSAVE_INTERVAL_MS * 2);
    expect(call).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('copies a dirty document at once, then at most once a minute', async () => {
    const { autosaver, call, writes } = setup();
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenLastCalledWith('save.autosave_bytes', { handle: 'doc-1' });
    expect(writes).toEqual([
      expect.objectContaining({
        tabId: 'tab-a',
        docId: 1,
        meta: expect.objectContaining({ name: 'report.pdf', pages: 3 }),
      }),
    ]);

    await advance(AUTOSAVE_INTERVAL_MS - 1000);
    expect(call).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(call).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(2);
  });

  it('never has two copies of one document in flight', async () => {
    let release: (value: Reply) => void = () => undefined;
    const { autosaver, call } = setup({
      answer: () => new Promise<Reply>((resolve) => (release = resolve)),
    });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([doc(), doc({ id: 2, handle: 'doc-2' })]);
    await advance(AUTOSAVE_INTERVAL_MS / 2);
    expect(call).toHaveBeenCalledTimes(2);
    expect(
      call.mock.calls.filter(([, p]) => (p as { handle: string }).handle === 'doc-1'),
    ).toHaveLength(1);
    release(reply());
  });

  it('asks again soon when the engine is busy', async () => {
    const { autosaver, call, writes } = setup({
      answer: async (n) => {
        if (n === 1) throw new RpcError('BUSY', 'a task is working');
        return reply();
      },
    });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    expect(call).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
    await advance(BUSY_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(1);
  });

  it('never copies a protected document, and removes nothing it did not write', async () => {
    const { autosaver, call, writes, warnings } = setup({
      answer: async () => ({ data: new ArrayBuffer(0), size: 0, skipped: 'protected' }),
    });
    autosaver.sync([doc()]);
    await advance(AUTOSAVE_INTERVAL_MS * 3);
    expect(call).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('warns once and stops a document over the autosave cap', async () => {
    const { autosaver, call, warnings } = setup({
      answer: async () => ({ data: new ArrayBuffer(0), size: 0, skipped: 'too_large' }),
    });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([doc({ handle: 'doc-1' })]);
    await advance(AUTOSAVE_INTERVAL_MS * 2);
    expect(call).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['tooLarge']);
  });

  it('treats a FILE_TOO_LARGE reply the same way as the cap', async () => {
    const { autosaver, call, warnings } = setup({
      answer: async () => {
        throw new RpcError('FILE_TOO_LARGE', 'too large', { max_bytes: 1, size: 2 });
      },
    });
    autosaver.sync([doc()]);
    await advance(AUTOSAVE_INTERVAL_MS * 2);
    expect(call).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['tooLarge']);
  });

  it('warns once when the browser has no private storage, and makes no engine call', async () => {
    const { autosaver, call, warnings } = setup({ store: { available: false } });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([doc({ id: 2, handle: 'doc-2' })]);
    await advance(AUTOSAVE_INTERVAL_MS * 2);
    expect(call).not.toHaveBeenCalled();
    expect(warnings).toEqual(['unavailable']);
  });

  it('warns once for a full disk and tries again later', async () => {
    const { autosaver, call, warnings } = setup({ store: { outcome: 'no-space' } });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    expect(call).toHaveBeenCalledTimes(1);
    await advance(ERROR_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual(['noSpace']);
  });

  it('removes the copy when the document becomes clean', async () => {
    const { autosaver, removes } = setup();
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([doc({ dirty: false })]);
    await advance(SETTLE_MS);
    expect(removes).toEqual([{ tabId: 'tab-a', docId: 1 }]);
  });

  it('removes the copy when the tab is closed, and stops copying it', async () => {
    const { autosaver, removes, call } = setup();
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([]);
    await advance(AUTOSAVE_INTERVAL_MS * 2);
    expect(removes).toEqual([{ tabId: 'tab-a', docId: 1 }]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('drops a write that finishes after its document was closed', async () => {
    let release: (value: Reply) => void = () => undefined;
    const { autosaver, writes, removes } = setup({
      answer: () => new Promise<Reply>((resolve) => (release = resolve)),
    });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([]);
    release(reply());
    await advance(SETTLE_MS);
    expect(writes).toHaveLength(0);
    expect(removes).toEqual([{ tabId: 'tab-a', docId: 1 }]);
  });

  it('asks the engine again after a reopen gives the document a new handle', async () => {
    const { autosaver, call } = setup({
      answer: async () => ({ data: new ArrayBuffer(0), size: 0, skipped: 'protected' }),
    });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    autosaver.sync([doc({ handle: 'doc-9' })]);
    await advance(SETTLE_MS);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith('save.autosave_bytes', { handle: 'doc-9' });
  });

  it('warns once and stops when the browser cannot write (no createWritable)', async () => {
    const { autosaver, call, warnings } = setup({ store: { outcome: 'unsupported' } });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    expect(warnings).toEqual(['unavailable']);
    autosaver.sync([doc({ id: 2, handle: 'doc-2' })]);
    await advance(AUTOSAVE_INTERVAL_MS * 3);
    expect(call).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(['unavailable']);
  });

  it('warns once on a write failure, and keeps trying every interval without warning again', async () => {
    const { autosaver, call, warnings } = setup({ store: { outcome: 'failed' } });
    autosaver.sync([doc()]);
    await advance(SETTLE_MS);
    expect(warnings).toEqual(['unavailable']);
    await advance(ERROR_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(2);
    await advance(ERROR_RETRY_MS);
    expect(call).toHaveBeenCalledTimes(3);
    expect(warnings).toEqual(['unavailable']);
  });

  it('keeps every copy on pagehide, and re-syncs after a restore from the back-forward cache', async () => {
    const { autosaver, removes, removedTabs, call } = setup();
    const page = new EventTarget();
    const docs = [doc()];
    const resync = vi.fn(() => autosaver.sync(docs));
    watchPageShow(page, resync);
    autosaver.sync(docs);
    await advance(SETTLE_MS);
    page.dispatchEvent(new Event('pagehide'));
    await advance(SETTLE_MS);
    expect(removes).toEqual([]);
    expect(removedTabs).toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);

    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    page.dispatchEvent(restored);
    expect(resync).toHaveBeenCalledTimes(1);
    page.dispatchEvent(new Event('pageshow'));
    expect(resync).toHaveBeenCalledTimes(1);
  });
});
