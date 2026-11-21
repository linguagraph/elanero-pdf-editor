import { describe, expect, it, vi } from 'vitest';
import { drawPixels } from './pixels';

// A canvas whose 2D context records what is drawn onto it.
function fakeCanvas() {
  const context = {
    drawImage: vi.fn(),
    createImageData: vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    })),
    putImageData: vi.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    dataset: {} as Record<string, string>,
    getContext: vi.fn(() => context),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, context, raw: canvas };
}

describe('drawPixels (W5.1b S5)', () => {
  it('draws a bitmap reply with drawImage, and not through the pixel buffer', () => {
    const { canvas, context, raw } = fakeCanvas();
    const bitmap = { close: vi.fn(), width: 3, height: 2 } as unknown as ImageBitmap;
    drawPixels(canvas, { width: 3, height: 2, pixels: new ArrayBuffer(0), bitmap });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(context.putImageData).not.toHaveBeenCalled();
    expect(raw.width).toBe(3);
    expect(raw.height).toBe(2);
    expect(raw.dataset.drawn).toBe('true');
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('leaves the ArrayBuffer path unchanged', () => {
    const { canvas, context, raw } = fakeCanvas();
    const pixels = new Uint8Array([1, 2, 3, 255]).buffer;
    drawPixels(canvas, { width: 1, height: 1, pixels });
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.createImageData).toHaveBeenCalledWith(1, 1);
    expect(context.putImageData).toHaveBeenCalledTimes(1);
    const put = context.putImageData.mock.calls[0]?.[0] as { data: Uint8ClampedArray };
    expect([...put.data]).toEqual([1, 2, 3, 255]);
    expect(raw.dataset.drawn).toBe('true');
  });
});
