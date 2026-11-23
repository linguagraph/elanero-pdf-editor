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
import { createFontLibrary, type FontLibrary, MAX_FONT_FILE_BYTES } from './fontLibrary';

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

interface Tab {
  readonly library: FontLibrary;
  readonly engine: ReturnType<typeof fakeEngine>;
  readonly notes: string[];
}

// One tab: its own engine and library over the given storage. Start-up syncs run at once.
function openTab(store: FontStore, persist: () => Promise<unknown> = async () => undefined): Tab {
  const engine = fakeEngine();
  const notes: string[] = [];
  const library = createFontLibrary({
    engine,
    store,
    persist,
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
});
