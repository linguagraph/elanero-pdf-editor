// The first-page previews of the recent files (issue 757): their object URLs are freed when a newer
// set replaces them or the hook unmounts, and a stale load never overwrites a newer one.
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine } from '../engine/testEngine';
import type { RecentThumbs } from '../recent/recentThumbs';
import { useDocuments, type Documents } from './useDocuments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A store whose loads the test settles by hand, in whatever order it likes.
function controlledStore() {
  const loads: { names: readonly string[]; reply: Deferred<Map<string, Blob>> }[] = [];
  const store: RecentThumbs = {
    save: vi.fn(async () => false),
    load: vi.fn((names: readonly string[]) => {
      const reply = deferred<Map<string, Blob>>();
      loads.push({ names, reply });
      return reply.promise;
    }),
    prune: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  return { store, loads };
}

let urlCount = 0;
let host: HTMLDivElement;
let root: Root;
let latest: Documents | undefined;
// One engine per test: the hook re-runs its effects when the engine object changes.
let engine: ReturnType<typeof fakeEngine>;

// The hook's result is handed out from an effect, so the test reads the latest render.
function Probe(props: { store: RecentThumbs }) {
  const docs = useDocuments(engine, undefined, props.store);
  useEffect(() => {
    latest = docs;
  });
  return null;
}

function mount(store: RecentThumbs): void {
  act(() => {
    root.render(<Probe store={store} />);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function blob(text: string): Blob {
  return new Blob([text], { type: 'image/jpeg' });
}

beforeEach(() => {
  window.localStorage.clear();
  urlCount = 0;
  latest = undefined;
  // jsdom has no object URLs: the test stands in for both calls.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:preview-${++urlCount}`),
    revokeObjectURL: vi.fn(),
  });
  engine = fakeEngine();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('useDocuments previews', () => {
  it('shows the loaded previews as object URLs', async () => {
    const { store, loads } = controlledStore();
    mount(store);
    await act(async () => {
      loads[0]?.reply.resolve(new Map([['a.pdf', blob('A')]]));
      await Promise.resolve();
    });
    await settle();
    expect(latest?.previews.get('a.pdf')).toBe('blob:preview-1');
  });

  it('frees the object URLs of the previews a newer set replaces', async () => {
    const { store, loads } = controlledStore();
    mount(store);
    await act(async () => {
      loads[0]?.reply.resolve(new Map([['a.pdf', blob('A')]]));
    });
    // A rename adds a name to the recent list, which loads the previews again.
    act(() => {
      latest?.renameTab(1, 'b.pdf');
    });
    await act(async () => {
      loads[1]?.reply.resolve(new Map([['b.pdf', blob('B')]]));
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-2');
    expect(latest?.previews.get('b.pdf')).toBe('blob:preview-2');
  });

  it('frees the URLs of a stale load that lands after a newer one, and keeps the newer list', async () => {
    const { store, loads } = controlledStore();
    mount(store);
    act(() => {
      latest?.renameTab(1, 'b.pdf');
    });
    // The newer load answers first, then the older one (issued at mount) lands.
    await act(async () => {
      loads[1]?.reply.resolve(new Map([['b.pdf', blob('NEW')]]));
    });
    await act(async () => {
      loads[0]?.reply.resolve(new Map([['a.pdf', blob('OLD')]]));
    });
    expect(latest?.previews.get('b.pdf')).toBe('blob:preview-1');
    expect(latest?.previews.has('a.pdf')).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-2');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-1');
  });

  it('frees the URLs of the shown previews on unmount', async () => {
    const { store, loads } = controlledStore();
    mount(store);
    await act(async () => {
      loads[0]?.reply.resolve(new Map([['a.pdf', blob('A')]]));
    });
    act(() => {
      root.unmount();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    // Remount for the afterEach unmount to act on a fresh root.
    root = createRoot(host);
  });

  it('frees the URL of a load that lands after unmount, instead of leaking it', async () => {
    const { store, loads } = controlledStore();
    mount(store);
    act(() => {
      root.unmount();
    });
    await act(async () => {
      loads[0]?.reply.resolve(new Map([['a.pdf', blob('A')]]));
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    root = createRoot(host);
  });

  it('prunes the previews to the recent list when a file is renamed', async () => {
    const { store } = controlledStore();
    mount(store);
    act(() => {
      latest?.renameTab(1, 'saved.pdf');
    });
    expect(store.prune).toHaveBeenCalledWith(['saved.pdf']);
  });
});
