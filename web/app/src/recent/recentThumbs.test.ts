import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '../engine/engineConnection';
import { addRecentFile } from './recentFiles';
import { type DirectoryLike } from '../storage/opfs';
import { MemoryDir } from '../storage/testRoot';
import {
  createRecentThumbs,
  keepRecentThumb,
  RECENT_THUMBS_FOLDER,
  renderRecentThumb,
  thumbFileName,
} from './recentThumbs';

function jpeg(text: string): Blob {
  return new Blob([text], { type: 'image/jpeg' });
}

// The folder the store writes to, reached through the same root the store is given.
async function thumbFolder(root: MemoryDir): Promise<MemoryDir> {
  return (await root.getDirectoryHandle(RECENT_THUMBS_FOLDER)) as MemoryDir;
}

describe('recent thumbnails store', () => {
  it('saves a thumbnail and loads it back by file name', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    expect(await store.save('a.pdf', jpeg('AAA'), false)).toBe(true);
    const loaded = await store.load(['a.pdf', 'missing.pdf']);
    expect([...loaded.keys()]).toEqual(['a.pdf']);
    expect(await loaded.get('a.pdf')?.text()).toBe('AAA');
  });

  it('names the file by the sha256 of the recent name, never by the name itself', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    await store.save('secret plan.pdf', jpeg('x'), false);
    const folder = await thumbFolder(root);
    expect([...folder.files.keys()]).toEqual([await thumbFileName('secret plan.pdf')]);
    expect(await thumbFileName('secret plan.pdf')).toMatch(/^[0-9a-f]{64}\.jpg$/);
  });

  it('deletes the thumbnails of names no longer in the list', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    await store.save('a.pdf', jpeg('A'), false);
    await store.save('b.pdf', jpeg('B'), false);
    await store.prune(['b.pdf']);
    const folder = await thumbFolder(root);
    expect([...folder.files.keys()]).toEqual([await thumbFileName('b.pdf')]);
    expect((await store.load(['a.pdf'])).size).toBe(0);
  });

  it('never stores a thumbnail of an encrypted file', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    expect(await store.save('locked.pdf', jpeg('X'), true)).toBe(false);
    expect(root.dirs.has(RECENT_THUMBS_FOLDER)).toBe(false);
    expect((await store.load(['locked.pdf'])).size).toBe(0);
  });

  it('gives an empty map and never throws when the private storage throws', async () => {
    const store = createRecentThumbs(async (): Promise<DirectoryLike> => {
      throw new Error('blocked');
    });
    expect((await store.load(['a.pdf'])).size).toBe(0);
    expect(await store.save('a.pdf', jpeg('A'), false)).toBe(false);
    await expect(store.prune(['a.pdf'])).resolves.toBeUndefined();
  });

  it('deletes the preview of one name and never throws when there is none', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    await store.save('a.pdf', jpeg('A'), false);
    await store.save('b.pdf', jpeg('B'), false);
    await store.remove('a.pdf');
    await expect(store.remove('missing.pdf')).resolves.toBeUndefined();
    expect((await store.load(['a.pdf', 'b.pdf'])).size).toBe(1);
  });
});

// A client whose replies the test scripts. Only the methods the preview uses are answered.
function scriptedClient(
  reply: (method: string) => unknown | Promise<unknown>,
): EngineClient & { call: ReturnType<typeof vi.fn> } {
  return { call: vi.fn(async (method: string) => reply(method)) } as unknown as EngineClient & {
    call: ReturnType<typeof vi.fn>;
  };
}

// A one-page document reply and a render of the given pixel size.
function renderReply(width: number, height: number): (method: string) => unknown {
  return (method) => {
    if (method === 'session.pages') {
      return { pages: [{ width: 612, height: 792, rotation: 0 }] };
    }
    if (method === 'render.page') {
      return { width, height, pixels: new ArrayBuffer(width * height * 4) };
    }
    throw new Error(`unexpected ${method}`);
  };
}

describe('renderRecentThumb', () => {
  const originalRatio = window.devicePixelRatio;
  let jpegSizes: [number, number][];

  beforeEach(() => {
    jpegSizes = [];
    const context = {
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      jpegSizes.push([this.width, this.height]);
      callback(new Blob(['jpeg'], { type: 'image/jpeg' }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: originalRatio,
    });
  });

  function setRatio(value: number): void {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
  }

  it('renders the first page at the quantized scale that fits the box, as a JPEG of the image size', async () => {
    setRatio(1);
    const client = scriptedClient(renderReply(111, 144));
    const blob = await renderRecentThumb(client, 'doc-1');
    // 612 x 792 pt in a 112 x 144 CSS px box: the height is the limit, 144 / 792 = 0.1818 device
    // px per point, which quantizes to 182 thousandths.
    expect(client.call).toHaveBeenLastCalledWith('render.page', {
      handle: 'doc-1',
      page: 0,
      revision: 0,
      scale_milli: 182,
      rotation: 0,
      annotations: true,
    });
    expect(jpegSizes).toEqual([[111, 144]]);
    expect(blob?.type).toBe('image/jpeg');
  });

  it('scales the box by the device pixel ratio, capped at 2', async () => {
    setRatio(4);
    const client = scriptedClient(renderReply(222, 288));
    await renderRecentThumb(client, 'doc-1');
    // The ratio is capped at 2: the box is 224 x 288 device px, which quantizes to 364.
    expect(client.call).toHaveBeenLastCalledWith(
      'render.page',
      expect.objectContaining({ scale_milli: 364 }),
    );
  });

  it('gives no preview when the document has no page', async () => {
    const client = scriptedClient((method) =>
      method === 'session.pages' ? { pages: [] } : renderReply(1, 1)(method),
    );
    expect(await renderRecentThumb(client, 'doc-1')).toBeUndefined();
    expect(client.call).not.toHaveBeenCalledWith('render.page', expect.anything());
  });

  it('gives no preview when the render is empty', async () => {
    const client = scriptedClient(renderReply(0, 0));
    expect(await renderRecentThumb(client, 'doc-1')).toBeUndefined();
    expect(jpegSizes).toEqual([]);
  });

  it('gives no preview when the browser cannot encode the JPEG', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementationOnce((callback) => {
      callback(null);
    });
    const client = scriptedClient(renderReply(111, 144));
    expect(await renderRecentThumb(client, 'doc-1')).toBeUndefined();
  });
});

describe('keepRecentThumb', () => {
  // A preview kept under the name before the file was replaced by one with no preview.
  async function storeWithOldPreview(
    root: MemoryDir,
  ): Promise<ReturnType<typeof createRecentThumbs>> {
    const store = createRecentThumbs(async () => root);
    expect(await store.save('a.pdf', new Blob(['OLD']), false)).toBe(true);
    return store;
  }

  it('removes the old preview of a name when the new file is encrypted', async () => {
    const root = new MemoryDir();
    const store = await storeWithOldPreview(root);
    const client = scriptedClient(renderReply(111, 144));
    await keepRecentThumb(store, client, 'doc-1', 'a.pdf', true);
    expect((await store.load(['a.pdf'])).size).toBe(0);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('removes the old preview of a name when the new file fails to render', async () => {
    const root = new MemoryDir();
    const store = await storeWithOldPreview(root);
    const client = scriptedClient(renderReply(0, 0));
    await expect(keepRecentThumb(store, client, 'doc-1', 'a.pdf', false)).resolves.toBeUndefined();
    expect((await store.load(['a.pdf'])).size).toBe(0);
  });

  it('removes the old preview and does not throw when the render call rejects', async () => {
    const root = new MemoryDir();
    const store = await storeWithOldPreview(root);
    const client = scriptedClient((method) => {
      if (method === 'session.pages') throw new Error('engine gone');
      return renderReply(1, 1)(method);
    });
    await expect(keepRecentThumb(store, client, 'doc-1', 'a.pdf', false)).resolves.toBeUndefined();
    expect((await store.load(['a.pdf'])).size).toBe(0);
  });

  it('replaces the old preview with the new one when the render works', async () => {
    const root = new MemoryDir();
    const store = await storeWithOldPreview(root);
    const client = scriptedClient(renderReply(111, 144));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['NEW'], { type: 'image/jpeg' }));
    });
    // The name is on the recent list, as it is when the file opens: the prune keeps its preview.
    window.localStorage.clear();
    addRecentFile('a.pdf');
    await keepRecentThumb(store, client, 'doc-1', 'a.pdf', false);
    expect(await (await store.load(['a.pdf'])).get('a.pdf')?.text()).toBe('NEW');
    vi.restoreAllMocks();
  });
});
