import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrintFile, pngSizeInPoints, printImages } from './printPages';

// A PNG header only: the signature, the IHDR chunk and a size. Enough for the size reader.
function pngHeader(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes.buffer;
}

function page(name: string, width: number, height: number): PrintFile {
  return { name, mime: 'image/png', data: pngHeader(width, height) };
}

let urlSeq = 0;
beforeEach(() => {
  urlSeq = 0;
  URL.createObjectURL = vi.fn(() => `blob:print-${++urlSeq}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('pngSizeInPoints', () => {
  it('converts the pixel size at the render resolution into points', () => {
    expect(pngSizeInPoints(pngHeader(1275, 1650), 150)).toEqual({ width: 612, height: 792 });
  });

  it('gives nothing for data that is not a PNG', () => {
    expect(pngSizeInPoints(new ArrayBuffer(24), 150)).toBeUndefined();
    expect(pngSizeInPoints(new ArrayBuffer(4), 150)).toBeUndefined();
  });
});

describe('printImages', () => {
  it('puts one image per page, in order, in a hidden iframe, then prints once after the images load', async () => {
    const seen: { count: number; srcs: string[]; frameInDom: boolean }[] = [];
    const print = vi.fn((win: Window) => {
      const images = [...win.document.querySelectorAll('img')];
      seen.push({
        count: images.length,
        srcs: images.map((img) => img.getAttribute('src') ?? ''),
        frameInDom: document.querySelector('iframe') !== null,
      });
    });
    const waitForImages = vi.fn(async () => undefined);

    await printImages([page('a.png', 150, 300), page('b.png', 300, 150)], {
      dpi: 150,
      print,
      waitForImages,
    });

    expect(waitForImages).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({
      count: 2,
      srcs: ['blob:print-1', 'blob:print-2'],
      frameInDom: true,
    });
  });

  it('sizes each image to its page in points', async () => {
    let widths: string[] = [];
    await printImages([page('a.png', 150, 300), page('b.png', 300, 150)], {
      dpi: 150,
      print: (win) => {
        widths = [...win.document.querySelectorAll('img')].map((img) => img.style.width);
      },
      waitForImages: async () => undefined,
    });
    expect(widths).toEqual(['72pt', '144pt']);
  });

  it('removes the iframe and revokes the blob URLs after the print dialog closes', async () => {
    let win: Window | undefined;
    await printImages([page('a.png', 150, 300)], {
      dpi: 150,
      print: (w) => {
        win = w;
        expect(document.querySelectorAll('iframe')).toHaveLength(1);
        w.dispatchEvent(new Event('afterprint'));
      },
      waitForImages: async () => undefined,
    });
    expect(win).toBeDefined();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:print-1');
  });

  it('removes the iframe at once when the images fail before printing', async () => {
    const print = vi.fn();
    await expect(
      printImages([page('a.png', 150, 300)], {
        dpi: 150,
        print,
        waitForImages: async () => {
          throw new Error('no images');
        },
      }),
    ).rejects.toThrow('no images');
    expect(print).not.toHaveBeenCalled();
    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:print-1');
  });
});
