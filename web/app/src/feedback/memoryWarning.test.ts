import { describe, expect, it } from 'vitest';
import type { MemoryResult } from '../rpc/generated';
import { createMemoryWarner, formatGiB, type MemoryEngine, REWARN_MS } from './memoryWarning';
import { createToastStore } from './toasts';

const GIB = 1024 ** 3;
const LIMIT = 1536 * 1024 ** 2;

function memory(wasm: number | null): MemoryResult {
  return { wasm_heap_bytes: wasm, heap_warn_bytes: LIMIT, snapshot_bytes: 0, documents: 1 };
}

// A fake engine whose system.memory reply can be changed between checks.
function fakeEngine(initial: MemoryResult | Error) {
  let reply = initial;
  const engine: MemoryEngine = {
    call: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return {
    engine,
    set(next: MemoryResult | Error) {
      reply = next;
    },
  };
}

function setup() {
  const store = createToastStore();
  let clock = 0;
  const warner = createMemoryWarner({ toasts: store, now: () => clock });
  return {
    store,
    warner,
    advance(ms: number) {
      clock += ms;
    },
    texts: () => store.getState().visible.map((toast) => toast.text),
  };
}

describe('heap warning (W3.9 S4)', () => {
  it('shows nothing at or below the limit', async () => {
    const { warner, store } = setup();
    const { engine } = fakeEngine(memory(LIMIT));
    await warner.check(engine, 'open');
    expect(store.getState().visible).toHaveLength(0);
  });

  it('shows one warning above the limit, naming the size', async () => {
    const { warner, texts } = setup();
    const { engine } = fakeEngine(memory(GIB + 0.6 * GIB));
    await warner.check(engine, 'open');
    expect(texts()).toEqual([
      'Elanero is using 1.6 GiB of memory. Close documents you are not using to keep it running smoothly.',
    ]);
  });

  it('shows nothing when the heap cannot be read', async () => {
    const { warner, store } = setup();
    const { engine } = fakeEngine(memory(null));
    await warner.check(engine, 'open');
    expect(store.getState().visible).toHaveLength(0);
  });

  it('shows nothing and does not throw when system.memory fails', async () => {
    const { warner, store } = setup();
    const { engine } = fakeEngine(new Error('timeout'));
    await expect(warner.check(engine, 'open')).resolves.toBeUndefined();
    expect(store.getState().visible).toHaveLength(0);
  });

  it('warns once per engine generation, even across job checks', async () => {
    const { warner, texts, advance } = setup();
    const { engine } = fakeEngine(memory(2 * GIB));
    await warner.check(engine, 'open');
    await warner.check(engine, 'job');
    advance(REWARN_MS * 2);
    await warner.check(engine, 'job');
    expect(texts()).toHaveLength(1);
  });

  it('warns again on a later open only after 10 minutes', async () => {
    const { warner, texts, advance } = setup();
    const { engine } = fakeEngine(memory(2 * GIB));
    await warner.check(engine, 'open');
    advance(REWARN_MS - 1);
    await warner.check(engine, 'open');
    expect(texts()).toHaveLength(1);
    advance(1);
    await warner.check(engine, 'open');
    expect(texts()).toHaveLength(2);
  });

  it('starts fresh for a new engine client (a restart)', async () => {
    const { warner, texts } = setup();
    await warner.check(fakeEngine(memory(2 * GIB)).engine, 'open');
    await warner.check(fakeEngine(memory(2 * GIB)).engine, 'open');
    expect(texts()).toHaveLength(2);
  });

  it('counts a job document copy after prepare', async () => {
    const { warner, texts } = setup();
    const { engine } = fakeEngine(memory(LIMIT - 100));
    await warner.check(engine, 'job', 50);
    expect(texts()).toHaveLength(0);
    await warner.check(engine, 'job', 200);
    expect(texts()).toHaveLength(1);
  });

  it('formats sizes in GiB to one decimal', () => {
    expect(formatGiB(1.56 * GIB)).toBe('1.6 GiB');
    expect(formatGiB(GIB)).toBe('1.0 GiB');
  });
});
