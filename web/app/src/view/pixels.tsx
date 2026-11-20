// Drawing cached pixels onto a canvas, shared by the document view and the thumbnails panel. The
// placeholder beneath the canvas shows until the pixels are there (W1.4 sections 6 and 9).
import { type CSSProperties, useEffect, useRef } from 'react';
import type { PageCache } from './pageCache';

export interface CachedDraw {
  readonly width: number;
  readonly height: number;
  readonly pixels: ArrayBuffer;
  // Set when the worker drew the page into a bitmap (W5.1b S5); the pixels are then empty.
  readonly bitmap?: ImageBitmap;
}

// Puts the pixels on the canvas at their device size. The canvas keeps its CSS size from the
// layout, so the device pixels are scaled into the box. drawImage copies the bitmap onto the canvas
// before it returns, so the caller's cache may close the bitmap afterwards.
export function drawPixels(canvas: HTMLCanvasElement, cached: CachedDraw): void {
  const context = canvas.getContext('2d');
  if (context === null) return;
  canvas.width = cached.width;
  canvas.height = cached.height;
  if (cached.bitmap !== undefined) {
    context.drawImage(cached.bitmap, 0, 0);
  } else {
    const image = context.createImageData(cached.width, cached.height);
    image.data.set(new Uint8ClampedArray(cached.pixels));
    context.putImageData(image, 0, 0);
  }
  canvas.dataset.drawn = 'true';
}

// A sharp layer that draws from the cache once the pixels are there. `version` changes whenever
// the cache may hold new pixels, so the effect runs again. `style` places a tile within its page.
export function CachedCanvas({
  cache,
  cacheKey,
  version,
  className,
  style,
}: {
  cache: PageCache;
  cacheKey: string;
  version: number;
  className: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const cached = cache.get(cacheKey);
    if (canvas !== null && cached !== undefined) drawPixels(canvas, cached);
  }, [cache, cacheKey, version]);
  return <canvas ref={ref} className={className} style={style} />;
}
