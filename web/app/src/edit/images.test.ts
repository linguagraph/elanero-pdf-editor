import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { pickFile } from '../files/pickFile';
import {
  addImage,
  chooseImage,
  dropPendingImage,
  isPngOrJpeg,
  MAX_IMAGE_BYTES,
  pendingImageOf,
  setPendingImage,
} from './images';

vi.mock('../files/pickFile', () => ({ pickFile: vi.fn() }));

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

function fileOf(bytes: number[], size?: number): File {
  const file = new File([new Uint8Array(bytes)], 'picture', { type: 'image/png' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('isPngOrJpeg', () => {
  it('accepts the PNG and JPEG signatures', () => {
    expect(isPngOrJpeg(new Uint8Array(PNG_HEAD))).toBe(true);
    expect(isPngOrJpeg(new Uint8Array(JPEG_HEAD))).toBe(true);
  });

  it('refuses a GIF, a short head and anything else', () => {
    expect(isPngOrJpeg(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(false);
    expect(isPngOrJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
    expect(isPngOrJpeg(new Uint8Array(0))).toBe(false);
  });
});

describe('chooseImage', () => {
  beforeEach(() => {
    vi.mocked(pickFile).mockReset();
  });

  it('returns null and shows nothing when the user cancels the picker', async () => {
    const store = createToastStore();
    vi.mocked(pickFile).mockResolvedValueOnce(null);
    expect(await chooseImage(store)).toBeNull();
    expect(store.getState().visible).toHaveLength(0);
  });

  it('returns a PNG or JPEG file as it was picked', async () => {
    const store = createToastStore();
    const png = fileOf(PNG_HEAD);
    vi.mocked(pickFile).mockResolvedValueOnce(png);
    expect(await chooseImage(store)).toBe(png);
    expect(vi.mocked(pickFile).mock.calls[0]?.[0]).toContain('image/png');
  });

  it('refuses a file that is not a PNG or JPEG, with the message, and keeps nothing', async () => {
    const store = createToastStore();
    vi.mocked(pickFile).mockResolvedValueOnce(fileOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    expect(await chooseImage(store)).toBeNull();
    expect(store.getState().visible[0]?.text).toBe(t('edit.image.wrongType'));
    expect(store.getState().visible[0]?.kind).toBe('error');
  });

  it('refuses a file over the size cap, and names the cap in megabytes', async () => {
    const store = createToastStore();
    vi.mocked(pickFile).mockResolvedValueOnce(fileOf(PNG_HEAD, MAX_IMAGE_BYTES + 1));
    expect(await chooseImage(store)).toBeNull();
    expect(store.getState().visible[0]?.text).toBe(t('edit.image.tooLarge', { mb: 50 }));
  });
});

describe('the pending file per tab', () => {
  it('holds the file for its tab until it is dropped', () => {
    const file = fileOf(PNG_HEAD);
    setPendingImage(7, file);
    expect(pendingImageOf(7)).toBe(file);
    expect(pendingImageOf(8)).toBeUndefined();
    dropPendingImage(7);
    expect(pendingImageOf(7)).toBeUndefined();
  });
});

describe('addImage', () => {
  const rect = { x0: 100, y0: 300, x1: 300, y1: 500 };

  function setup(reply: Partial<{ executed: boolean }> = {}, rejection?: unknown) {
    const call = vi.fn(async () => {
      if (rejection !== undefined) throw rejection;
      return {
        label: 'Add Image',
        executed: reply.executed ?? true,
        value: null,
        changed: { changes: [], revisions: { '0': 3 } },
        state: { history: 7 },
      };
    });
    const noteRevisions = vi.fn();
    const cache = { clear: vi.fn() };
    const store = createToastStore();
    const deps = {
      rpc: { call } as unknown as PageRpc,
      handle: 'h1',
      cache,
      scheduler: { noteRevisions },
      store,
    };
    return { call, noteRevisions, cache, store, deps };
  }

  it('sends content.add_image with the page, the box, the bytes and keep_proportion', async () => {
    const { call, deps } = setup();
    const bytes = new Uint8Array([...PNG_HEAD, 1, 2, 3]);
    const file = new File([bytes], 'p.png', { type: 'image/png' });
    expect(await addImage(deps, 2, rect, file)).toBe(true);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.add_image',
      args: { page: 2, rect, data: expect.any(ArrayBuffer), keep_proportion: true },
    });
    const [, params] = call.mock.calls[0] as unknown as [string, { args: { data: ArrayBuffer } }];
    expect(new Uint8Array(params.args.data)).toEqual(bytes);
  });

  it('redraws the changed pages, clears the object lists and offers Undo', async () => {
    const { cache, noteRevisions, store, deps } = setup();
    await addImage(deps, 0, rect, fileOf(PNG_HEAD));
    expect(cache.clear).toHaveBeenCalled();
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 3 });
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('edit.image.added'));
    expect(toast?.action?.label).toBe(t('toast.undo'));
  });

  it('an engine refusal shows its message and returns false, so the file can be placed again', async () => {
    const { store, deps } = setup(
      {},
      new RpcError('REFUSED', 'Only PNG and JPEG images can be added here.', {
        reason: 'image_format',
      }),
    );
    const file = fileOf(PNG_HEAD);
    expect(await addImage(deps, 0, rect, file)).toBe(false);
    expect(store.getState().visible[0]?.text).toBe(t('error.REFUSED.imageFormat'));
  });

  it('a read failure shows the generic edit failure and sends nothing', async () => {
    const { call, store, deps } = setup();
    const broken = {
      size: 8,
      arrayBuffer: () => Promise.reject(new Error('gone')),
    } as unknown as Blob;
    expect(await addImage(deps, 0, rect, broken)).toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.text).toBe(t('edit.failed'));
  });

  it('a call the engine did not execute returns false and offers no Undo', async () => {
    const { store, deps } = setup({ executed: false });
    expect(await addImage(deps, 0, rect, fileOf(PNG_HEAD))).toBe(false);
    await settle();
    expect(store.getState().visible).toHaveLength(0);
  });
});
