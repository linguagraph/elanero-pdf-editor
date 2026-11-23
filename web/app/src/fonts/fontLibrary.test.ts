import { describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '../engine/engineConnection';
import { fakeEngine } from '../engine/testEngine';
import { RpcError, type RpcErrorCode } from '../rpc/client';
import type { UploadedFontDto } from '../rpc/generated';
import {
  createFontStore,
  FONTS_FOLDER,
  type FontStore,
  type KeepOutcome,
} from '../storage/fontStore';
import { StorageUnsupportedError } from '../storage/opfs';
import { MemoryDir, memoryRoot } from '../storage/testRoot';
import {
  type ChannelLike,
  createFontLibrary,
  type FontLibrary,
  type FontMessage,
  MAX_FONT_FILE_BYTES,
  parseFontMessage,
} from './fontLibrary';

const estimate = async () => ({ quota: 10_000_000, usage: 0 });

function fontFile(name: string, text = name): File {
  return new File([text], name);
}

async function idOf(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// An engine client that keeps the fonts it is sent, as the worker's store does. `refuse` makes a
// fonts.add fail for the names it returns an error for.
function fakeClient(refuse: (name: string) => RpcError | undefined = () => undefined) {
  const loaded = new Map<string, UploadedFontDto>();
  const call = vi.fn(
    async (method: string, params: { name?: string; data?: ArrayBuffer; id?: string }) => {
      if (method === 'fonts.add') {
        const refusal = refuse(params.name ?? '');
        if (refusal !== undefined) throw refusal;
        const data = params.data ?? new ArrayBuffer(0);
        const id = await idOf(data);
        const added = !loaded.has(id);
        const dto: UploadedFontDto = {
          id,
          name: params.name ?? '',
          format: 'truetype',
          size: data.byteLength,
          path: `/fonts/${id}.ttf`,
          faces: [],
          refused: [],
        };
        loaded.set(id, dto);
        return { font: dto, added, used_bytes: 0, max_bytes: 1000 };
      }
      if (method === 'fonts.list')
        return { fonts: [...loaded.values()], used_bytes: 0, max_bytes: 1000 };
      if (method === 'fonts.remove') {
        loaded.delete(params.id ?? '');
        return {};
      }
      throw new Error(`unexpected call ${method}`);
    },
  );
  return {
    client: { call, chunked: vi.fn() } as unknown as EngineClient,
    call,
    loaded,
    calls: () => call.mock.calls.map((entry) => entry[0]),
  };
}

// A store that answers every write with one outcome, for the keep outcomes.
function storeAnswering(outcome: KeepOutcome): FontStore {
  return {
    available: async () => true,
    list: async () => [],
    read: async () => undefined,
    write: async () => outcome,
    remove: async () => true,
    removeAll: async () => true,
  };
}

// A stand-in for the tabs' BroadcastChannel. Messages wait until the test delivers them, so the test
// decides which tab hears of a change first. A channel never hears its own messages.
class FakeHub {
  private readonly sets: Set<(event: { readonly data: unknown }) => void>[] = [];
  private readonly queue: { readonly from: number; readonly data: FontMessage }[] = [];

  channel(): ChannelLike {
    const index = this.sets.length;
    const listeners = new Set<(event: { readonly data: unknown }) => void>();
    this.sets.push(listeners);
    return {
      postMessage: (data) => {
        this.queue.push({ from: index, data });
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
    };
  }

  // How many messages are queued and not yet delivered.
  pending(): number {
    return this.queue.length;
  }

  // Delivers the queued messages, in the order they were sent.
  deliver(): void {
    for (const { from, data } of this.queue.splice(0)) this.broadcast(from, data);
  }

  // A message this module did not send, as another page's script might.
  inject(data: unknown): void {
    this.broadcast(-1, data);
  }

  private broadcast(from: number, data: unknown): void {
    this.sets.forEach((listeners, index) => {
      if (index === from) return;
      for (const listener of [...listeners]) listener({ data });
    });
  }
}

// Waits until the tab has run every job it queued.
async function settle(library: FontLibrary): Promise<void> {
  for (let turn = 0; turn < 1000 && library.getState().busy; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Tab {
  readonly library: FontLibrary;
  readonly engine: ReturnType<typeof fakeEngine>;
  readonly notes: string[];
}

// One tab: its own engine and library over the given storage. Start-up syncs run at once. Tabs that
// share a hub hear each other's broadcasts; a tab on its own gets a hub of its own.
function openTab(
  store: FontStore,
  persist: () => Promise<unknown> = async () => undefined,
  hub: FakeHub = new FakeHub(),
): Tab {
  const engine = fakeEngine();
  const notes: string[] = [];
  const library = createFontLibrary({
    engine,
    store,
    persist,
    channel: () => hub.channel(),
    schedule: (run) => run(),
    notify: (text) => notes.push(text),
  });
  return { library, engine, notes };
}

describe('font library', () => {
  it('keeps an added font in the store and lists it as kept and loaded', async () => {
    const root = new MemoryDir();
    const tab = openTab(createFontStore(memoryRoot(root), estimate));
    const engine = fakeClient();
    tab.engine.setClient(engine.client);

    const outcome = await tab.library.add(fontFile('Sans.ttf', 'sans'));

    expect(outcome.kind).toBe('added');
    expect(tab.library.getState()).toMatchObject({ storage: 'persistent', maxBytes: 1000 });
    expect(tab.library.getState().fonts).toEqual([
      expect.objectContaining({ name: 'Sans.ttf', kept: true, loaded: true }),
    ]);
    expect(root.dirs.get(FONTS_FOLDER)?.files.size).toBe(2);
  });

  it('waits for the engine before adding, and never keeps a font the engine refuses', async () => {
    const root = new MemoryDir();
    const tab = openTab(createFontStore(memoryRoot(root), estimate));
    const pending = tab.library.add(fontFile('Bad.ttf', 'bad'));
    const engine = fakeClient(() => new RpcError('INVALID_FONT', 'not a font'));
    tab.engine.setClient(engine.client);

    expect(await pending).toEqual({
      kind: 'refused',
      code: 'INVALID_FONT',
      details: {},
    });
    expect(root.dirs.has(FONTS_FOLDER)).toBe(false);
    expect(tab.library.getState().fonts).toEqual([]);
  });

  it('refuses a file over the per-file limit without calling the engine', async () => {
    const tab = openTab(createFontStore(memoryRoot(new MemoryDir()), estimate));
    const engine = fakeClient();
    tab.engine.setClient(engine.client);
    const huge = { name: 'huge.ttf', size: MAX_FONT_FILE_BYTES + 1 } as unknown as File;

    expect(await tab.library.add(huge)).toEqual({ kind: 'tooLarge' });
    expect(engine.call).not.toHaveBeenCalled();
  });

  it('keeps a font for this tab only when the browser has no private storage', async () => {
    const store = createFontStore(async () => {
      throw new StorageUnsupportedError('no storage');
    }, estimate);
    const tab = openTab(store);
    const engine = fakeClient();
    tab.engine.setClient(engine.client);

    const outcome = await tab.library.add(fontFile('Sans.ttf', 'sans'));

    expect(outcome).toMatchObject({ kind: 'notKept', reason: 'unsupported' });
    expect(tab.library.getState()).toMatchObject({ storage: 'session' });
    expect(tab.library.getState().fonts[0]).toMatchObject({ kept: false, loaded: true });
    const again = await tab.library.bytes(tab.library.getState().fonts[0]?.id ?? '');
    expect(again?.size).toBe(4);
  });

  it.each([
    ['no-space', 'no-space'],
    ['failed', 'failed'],
  ] as const)('keeps a font for this tab when the store says %s', async (outcome, reason) => {
    const tab = openTab(storeAnswering(outcome));
    tab.engine.setClient(fakeClient().client);

    expect(await tab.library.add(fontFile('Sans.ttf', 'sans'))).toMatchObject({
      kind: 'notKept',
      reason,
    });
    expect(tab.library.getState().fonts[0]).toMatchObject({ kept: false, loaded: true });
  });

  it('writes the File itself, because the send detached the buffer', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    const write = vi.spyOn(store, 'write');
    const tab = openTab(store);
    tab.engine.setClient(fakeClient().client);
    const file = fontFile('Sans.ttf', 'sans');

    await tab.library.add(file);

    expect(write.mock.calls[0]?.[1]).toBe(file);
    expect(await store.list()).toEqual([expect.objectContaining({ name: 'Sans.ttf' })]);
  });

  it('reports a font already kept as already, without a second copy', async () => {
    const root = new MemoryDir();
    const tab = openTab(createFontStore(memoryRoot(root), estimate));
    const engine = fakeClient();
    tab.engine.setClient(engine.client);

    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const second = await tab.library.add(fontFile('Sans.ttf', 'sans'));

    expect(second.kind).toBe('already');
    expect(root.dirs.get(FONTS_FOLDER)?.files.size).toBe(2);
  });

  it('asks for persistent storage once, after the first kept font', async () => {
    const persist = vi.fn(async () => undefined);
    const tab = openTab(createFontStore(memoryRoot(new MemoryDir()), estimate), persist);
    tab.engine.setClient(fakeClient().client);

    await tab.library.add(fontFile('A.ttf', 'a'));
    await tab.library.add(fontFile('B.ttf', 'b'));

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('runs two operations started together one after the other', async () => {
    const base = fakeClient();
    let running = 0;
    let peak = 0;
    const slow = {
      call: async (method: string, params: { name?: string; data?: ArrayBuffer }) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await base.call(method, params);
        } finally {
          running -= 1;
        }
      },
      chunked: vi.fn(),
    } as unknown as EngineClient;
    const tab = openTab(createFontStore(memoryRoot(new MemoryDir()), estimate));
    tab.engine.setClient(slow);

    await Promise.all([
      tab.library.add(fontFile('A.ttf', 'a')),
      tab.library.add(fontFile('B.ttf', 'b')),
    ]);

    expect(peak).toBe(1);
    expect(tab.library.getState().fonts).toHaveLength(2);
  });

  it('sends every kept font to a new engine, and resolves ready once it has', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    const first = openTab(store);
    first.engine.setClient(fakeClient().client);
    await first.library.add(fontFile('Sans.ttf', 'sans'));

    const second = openTab(store);
    const engine = fakeClient();
    second.engine.setClient(engine.client);
    await second.library.ready();

    expect(engine.calls()).toEqual(['fonts.add', 'fonts.list']);
    expect(second.library.getState().fonts).toEqual([
      expect.objectContaining({ name: 'Sans.ttf', kept: true, loaded: true }),
    ]);
    expect(second.library.getState().fonts[0]?.dto?.name).toBe('Sans.ttf');
  });

  it('calls no engine when no font is kept', async () => {
    const tab = openTab(createFontStore(memoryRoot(new MemoryDir()), estimate));
    const engine = fakeClient();
    tab.engine.setClient(engine.client);

    await tab.library.ready();

    expect(engine.call).not.toHaveBeenCalled();
  });

  it('sends the fonts again to a restarted engine, but not to the same one twice', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    const tab = openTab(store);
    const first = fakeClient();
    tab.engine.setClient(first.client);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));

    tab.engine.setClient(first.client);
    expect(first.calls().filter((call) => call === 'fonts.add')).toHaveLength(1);

    const restarted = fakeClient();
    tab.engine.setClient(restarted.client);
    await tab.library.ready();
    expect(restarted.calls()).toContain('fonts.add');
  });

  it('sends the session fonts again after an engine restart', async () => {
    const store = createFontStore(async () => {
      throw new StorageUnsupportedError('no storage');
    }, estimate);
    const tab = openTab(store);
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('Mem.ttf', 'mem'));

    const restarted = fakeClient();
    tab.engine.setClient(restarted.client);
    await tab.library.ready();

    expect(restarted.calls()).toContain('fonts.add');
    expect(tab.library.getState().fonts[0]).toMatchObject({ kept: false, loaded: true });
  });

  it.each<RpcErrorCode>(['INVALID_FONT', 'FONT_NOT_EMBEDDABLE', 'FILE_TOO_LARGE'])(
    'drops a kept font the engine refuses with %s, with one notice',
    async (code) => {
      const root = new MemoryDir();
      const store = createFontStore(memoryRoot(root), estimate);
      await store.write(
        { id: 'c'.repeat(64), name: 'Old.ttf', size: 3, fontFormat: 'truetype', added: 'x' },
        new Blob(['old']),
      );
      const tab = openTab(store);
      tab.engine.setClient(fakeClient(() => new RpcError(code, 'refused')).client);
      await tab.library.ready();

      expect(await store.list()).toEqual([]);
      expect(tab.library.getState().fonts).toEqual([]);
      expect(tab.notes).toEqual([expect.stringContaining('Old.ttf')]);
    },
  );

  it.each<RpcErrorCode>(['NOT_SUPPORTED', 'FONT_STORAGE_FULL', 'OUT_OF_MEMORY'])(
    'keeps a font the engine could not load now (%s), and says so once',
    async (code) => {
      const root = new MemoryDir();
      const store = createFontStore(memoryRoot(root), estimate);
      const first = openTab(store);
      first.engine.setClient(fakeClient().client);
      await first.library.add(fontFile('Sans.ttf', 'sans'));

      const full = openTab(store);
      full.engine.setClient(fakeClient(() => new RpcError(code, 'later')).client);
      await full.library.ready();

      expect((await store.list()).map((record) => record.name)).toEqual(['Sans.ttf']);
      expect(full.library.getState().fonts).toEqual([
        expect.objectContaining({ name: 'Sans.ttf', kept: true, loaded: false, dto: undefined }),
      ]);
      expect(full.notes).toEqual([expect.stringContaining('could not be loaded')]);
    },
  );

  it('drops a kept font whose bytes give a different id, and removes the new id from the engine', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    await store.write(
      { id: 'd'.repeat(64), name: 'Changed.ttf', size: 3, fontFormat: 'truetype', added: 'x' },
      new Blob(['new']),
    );
    const tab = openTab(store);
    const reply = {
      font: {
        id: 'e'.repeat(64),
        name: 'Changed.ttf',
        format: 'truetype',
        size: 3,
        path: '',
        faces: [],
        refused: [],
      },
      added: true,
      used_bytes: 0,
      max_bytes: 1,
    };
    const call = vi.fn(async (method: string) => {
      if (method === 'fonts.add') return reply;
      if (method === 'fonts.remove') return {};
      return { fonts: [], used_bytes: 0, max_bytes: 1 };
    });
    tab.engine.setClient({ call, chunked: vi.fn() } as unknown as EngineClient);
    await tab.library.ready();

    expect(await store.list()).toEqual([]);
    expect(tab.notes).toHaveLength(1);
    expect(call).toHaveBeenCalledWith('fonts.remove', { id: 'e'.repeat(64) });
  });

  it('leaves an add that an engine restart overtook unloaded, so the new engine gets the font', async () => {
    const tab = openTab(createFontStore(memoryRoot(new MemoryDir()), estimate));
    const first = fakeClient();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const addStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    // The first engine holds its fonts.add open until the test releases it.
    const slowFirst = {
      call: async (method: string, params: { name?: string; data?: ArrayBuffer; id?: string }) => {
        if (method === 'fonts.add') {
          started();
          await held;
        }
        return first.call(method, params);
      },
      chunked: vi.fn(),
    } as unknown as EngineClient;
    tab.engine.setClient(slowFirst);
    const pending = tab.library.add(fontFile('Sans.ttf', 'sans'));
    await addStarted;

    const second = fakeClient();
    tab.engine.setClient(second.client);
    release();
    await pending;
    await tab.library.ready();

    expect(second.calls()).toContain('fonts.add');
    const secondDto = [...second.loaded.values()][0];
    expect(tab.library.getState().fonts).toEqual([
      expect.objectContaining({ name: 'Sans.ttf', kept: true, loaded: true, dto: secondDto }),
    ]);
  });

  it('removes a font from the disk, the engine and the list, and tells the listeners', async () => {
    const root = new MemoryDir();
    const tab = openTab(createFontStore(memoryRoot(root), estimate));
    const engine = fakeClient();
    tab.engine.setClient(engine.client);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const id = tab.library.getState().fonts[0]?.id ?? '';
    const removed = vi.fn();
    tab.library.onRemoved(removed);

    expect(await tab.library.remove(id)).toEqual({ kind: 'removed' });

    expect(tab.library.getState().fonts).toEqual([]);
    expect(engine.loaded.size).toBe(0);
    expect(root.dirs.has(FONTS_FOLDER)).toBe(false);
    expect(removed).toHaveBeenCalledWith(id);
  });

  it('removes every font and the fonts folder with removeAll', async () => {
    const root = new MemoryDir();
    const tab = openTab(createFontStore(memoryRoot(root), estimate));
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('A.ttf', 'a'));
    await tab.library.add(fontFile('B.ttf', 'b'));

    expect(await tab.library.removeAll()).toEqual({ kind: 'removed' });

    expect(tab.library.getState().fonts).toEqual([]);
    expect(root.dirs.has(FONTS_FOLDER)).toBe(false);
  });

  it('reports engineKept when the engine cannot drop the font, and removes it from the disk anyway', async () => {
    const store = createFontStore(memoryRoot(new MemoryDir()), estimate);
    const tab = openTab(store);
    const engine = fakeClient();
    tab.engine.setClient({
      call: vi.fn(
        async (method: string, params: { name?: string; data?: ArrayBuffer; id?: string }) =>
          method === 'fonts.remove'
            ? Promise.reject(new RpcError('ENGINE_ERROR', 'busy'))
            : engine.call(method, params),
      ),
      chunked: vi.fn(),
    } as unknown as EngineClient);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const id = tab.library.getState().fonts[0]?.id ?? '';

    expect(await tab.library.remove(id)).toEqual({ kind: 'engineKept', code: 'ENGINE_ERROR' });
    expect(tab.library.getState().fonts).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('keeps the font listed when the disk refuses the removal', async () => {
    const store = createFontStore(memoryRoot(new MemoryDir()), estimate);
    const tab = openTab(store);
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const id = tab.library.getState().fonts[0]?.id ?? '';
    vi.spyOn(store, 'remove').mockResolvedValueOnce(false);

    expect(await tab.library.remove(id)).toEqual({ kind: 'notRemoved' });
    expect(tab.library.getState().fonts).toEqual([expect.objectContaining({ id, kept: true })]);
  });

  it('loads a font another tab kept, without a reload, and only that font', async () => {
    const hub = new FakeHub();
    const root = new MemoryDir();
    const first = openTab(createFontStore(memoryRoot(root), estimate), undefined, hub);
    const second = openTab(createFontStore(memoryRoot(root), estimate), undefined, hub);
    first.engine.setClient(fakeClient().client);
    const engine = fakeClient();
    second.engine.setClient(engine.client);

    await first.library.add(fontFile('Sans.ttf', 'sans'));
    hub.deliver();
    await settle(second.library);

    expect(second.library.getState().fonts).toEqual([
      expect.objectContaining({ name: 'Sans.ttf', kept: true, loaded: true }),
    ]);
    // The second engine sent only the one font: the start-up sync had nothing to send.
    expect(engine.calls()).toEqual(['fonts.add', 'fonts.list']);
  });

  it('drops every font when another tab clears local data, and leaves the disk to the tab that cleared', async () => {
    const hub = new FakeHub();
    const root = new MemoryDir();
    const storeA = createFontStore(memoryRoot(root), estimate);
    const storeB = createFontStore(memoryRoot(root), estimate);
    const first = openTab(storeA, undefined, hub);
    const second = openTab(storeB, undefined, hub);
    first.engine.setClient(fakeClient().client);
    const engine = fakeClient();
    second.engine.setClient(engine.client);
    await first.library.add(fontFile('Sans.ttf', 'sans'));
    hub.deliver();
    await settle(second.library);
    const removeB = vi.spyOn(storeB, 'remove');
    const removeAllB = vi.spyOn(storeB, 'removeAll');

    first.library.cleared();
    hub.deliver();
    await settle(second.library);

    expect(second.library.getState().fonts).toEqual([]);
    expect(engine.calls()).toContain('fonts.remove');
    expect(removeB).not.toHaveBeenCalled();
    expect(removeAllB).not.toHaveBeenCalled();
    expect(root.dirs.get(FONTS_FOLDER)?.files.size).toBe(2);
  });

  it('leaves the disk alone when a removal reaches a tab after another tab kept the font again', async () => {
    const hub = new FakeHub();
    const root = new MemoryDir();
    const first = openTab(createFontStore(memoryRoot(root), estimate), undefined, hub);
    const storeB = createFontStore(memoryRoot(root), estimate);
    const second = openTab(storeB, undefined, hub);
    const file = fontFile('Sans.ttf', 'sans');
    first.engine.setClient(fakeClient().client);
    second.engine.setClient(fakeClient().client);
    await first.library.add(file);
    hub.deliver();
    await settle(second.library);
    const id = first.library.getState().fonts[0]?.id ?? '';
    const removedB = vi.fn();
    second.library.onRemoved(removedB);
    const removeB = vi.spyOn(storeB, 'remove');

    await first.library.remove(id);
    // A third tab starts after the removal and keeps the same font again; its 'added' follows the
    // first tab's 'removed' in the hub.
    const third = openTab(createFontStore(memoryRoot(root), estimate), undefined, hub);
    third.engine.setClient(fakeClient().client);
    await third.library.add(file);
    hub.deliver();
    await settle(second.library);

    expect(removedB).toHaveBeenCalledWith(id);
    expect(removeB).not.toHaveBeenCalled();
    expect(await storeB.list()).toEqual([expect.objectContaining({ id })]);
    expect(second.library.getState().fonts).toEqual([
      expect.objectContaining({ id, kept: true, loaded: true }),
    ]);
  });

  it('queues an added message for a font kept on disk, so the other tabs hear of it', async () => {
    const hub = new FakeHub();
    const tab = openTab(createFontStore(memoryRoot(new MemoryDir()), estimate), undefined, hub);
    tab.engine.setClient(fakeClient().client);

    await tab.library.add(fontFile('Sans.ttf', 'sans'));

    expect(hub.pending()).toBe(1);
  });

  it.each(['no-space', 'unsupported', 'failed'] as const)(
    'queues no added message for a font whose store says %s',
    async (outcome) => {
      const hub = new FakeHub();
      const tab = openTab(storeAnswering(outcome), undefined, hub);
      tab.engine.setClient(fakeClient().client);

      await tab.library.add(fontFile('Sans.ttf', 'sans'));

      expect(hub.pending()).toBe(0);
    },
  );

  it('queues no removed message when a session font is removed', async () => {
    const hub = new FakeHub();
    const store = createFontStore(async () => {
      throw new StorageUnsupportedError('no storage');
    }, estimate);
    const tab = openTab(store, undefined, hub);
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('Mem.ttf', 'mem'));
    const id = tab.library.getState().fonts[0]?.id ?? '';

    expect(await tab.library.remove(id)).toEqual({ kind: 'removed' });
    expect(hub.pending()).toBe(0);
  });

  it('queues no removed message when the disk refuses the removal', async () => {
    const hub = new FakeHub();
    const store = createFontStore(memoryRoot(new MemoryDir()), estimate);
    const tab = openTab(store, undefined, hub);
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const id = tab.library.getState().fonts[0]?.id ?? '';
    // Drops the 'added' the add queued, so only what the removal queues is counted.
    hub.deliver();
    vi.spyOn(store, 'remove').mockResolvedValueOnce(false);

    expect(await tab.library.remove(id)).toEqual({ kind: 'notRemoved' });
    expect(hub.pending()).toBe(0);
  });

  it('queues a removed message for a kept font that is removed', async () => {
    const hub = new FakeHub();
    const store = createFontStore(memoryRoot(new MemoryDir()), estimate);
    const tab = openTab(store, undefined, hub);
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const id = tab.library.getState().fonts[0]?.id ?? '';
    hub.deliver();

    await tab.library.remove(id);
    expect(hub.pending()).toBe(1);
  });

  it('ignores messages it did not send', async () => {
    const hub = new FakeHub();
    const store = createFontStore(memoryRoot(new MemoryDir()), estimate);
    const tab = openTab(store, undefined, hub);
    tab.engine.setClient(fakeClient().client);
    await tab.library.add(fontFile('Sans.ttf', 'sans'));
    const removeOne = vi.spyOn(store, 'remove');
    const removeAll = vi.spyOn(store, 'removeAll');

    for (const data of [
      null,
      'removed',
      { kind: 'removed', id: '../x' },
      { kind: 'removed' },
      { kind: 'bogus', id: 'a'.repeat(64) },
    ]) {
      hub.inject(data);
    }
    await settle(tab.library);

    expect(tab.library.getState().fonts).toEqual([expect.objectContaining({ kept: true })]);
    expect(removeOne).not.toHaveBeenCalled();
    expect(removeAll).not.toHaveBeenCalled();
  });
});

describe('font messages', () => {
  it('accepts only the three kinds this module sends, with a font id for added and removed', () => {
    const id = 'a'.repeat(64);

    expect(parseFontMessage({ kind: 'added', id })).toEqual({ kind: 'added', id });
    expect(parseFontMessage({ kind: 'removed', id })).toEqual({ kind: 'removed', id });
    expect(parseFontMessage({ kind: 'cleared' })).toEqual({ kind: 'cleared' });
    expect(parseFontMessage({ kind: 'removed', id: 'short' })).toBeUndefined();
    expect(parseFontMessage({ kind: 'added' })).toBeUndefined();
    expect(parseFontMessage({ kind: 'other', id })).toBeUndefined();
    expect(parseFontMessage(null)).toBeUndefined();
    expect(parseFontMessage('cleared')).toBeUndefined();
  });
});
