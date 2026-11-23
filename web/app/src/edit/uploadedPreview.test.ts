// The preview face of an uploaded font (W6.8b 8b-3, design section 10): the bytes are read once per
// id, a null result is kept, and a face the browser rejects gives null.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFontLibrary } from '../fonts/testFontLibrary';
import type { BlobLike } from '../storage/opfs';
import { uploadedPreviewFace } from './uploadedPreview';

const blob = (): BlobLike => ({
  size: 8,
  arrayBuffer: async () => new ArrayBuffer(8),
  text: async () => '',
});

// A FontFace that loads: the name is the family the face is registered under.
class LoadingFace {
  readonly family: string;
  readonly bytes: number;
  constructor(family: string, data: ArrayBuffer) {
    this.family = family;
    this.bytes = data.byteLength;
  }
  load() {
    return Promise.resolve(this);
  }
}

// A FontFace the browser refuses to load.
class RejectedFace {
  load() {
    return Promise.reject(new Error('not a font'));
  }
}

beforeEach(() => {
  vi.stubGlobal('FontFace', LoadingFace);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as { fonts?: unknown }).fonts;
});

describe('uploadedPreviewFace', () => {
  it('reads the bytes once per font id and registers the face under its name', async () => {
    const id = 'a'.repeat(64);
    const library = fakeFontLibrary();
    const bytes = vi.fn<(id: string) => Promise<BlobLike | undefined>>(async () => blob());
    library.bytes = bytes;
    expect(await uploadedPreviewFace(library, id)).toBe(`upl-${id}`);
    expect(await uploadedPreviewFace(library, id)).toBe(`upl-${id}`);
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(bytes).toHaveBeenCalledWith(id);
  });

  it('caches a null result, so the library is not asked again', async () => {
    const id = 'b'.repeat(64);
    const library = fakeFontLibrary();
    const bytes = vi.fn<(id: string) => Promise<BlobLike | undefined>>(async () => undefined);
    library.bytes = bytes;
    expect(await uploadedPreviewFace(library, id)).toBeNull();
    expect(await uploadedPreviewFace(library, id)).toBeNull();
    expect(bytes).toHaveBeenCalledTimes(1);
  });

  it('gives null when the browser rejects the face, and registers nothing', async () => {
    const id = 'c'.repeat(64);
    vi.stubGlobal('FontFace', RejectedFace);
    const library = fakeFontLibrary();
    library.bytes = async () => blob();
    expect(await uploadedPreviewFace(library, id)).toBeNull();
    expect(document.fonts.add).not.toHaveBeenCalled();
  });
});
