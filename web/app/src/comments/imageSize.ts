// The pixel size of a PNG or JPEG, read from its header only (a port of custom_stamps.image_size,
// W7.3b design section 3.2). Nothing is decoded: a picture too large to decode is still measured, so
// the pixel cap can refuse it before the browser tries to paint it. Null for anything else, or for a
// header that is cut short or has a zero size.

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// JPEG start-of-frame markers (baseline, progressive, ...) that carry the image size.
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => data[i] === byte);
}

function sized(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

export function imageSize(data: Uint8Array): ImageSize | null {
  if (startsWith(data, PNG_SIGNATURE)) {
    // The IHDR chunk always comes first: width and height are big-endian at bytes 16 to 24.
    if (data.length < 24 || String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return sized(view.getUint32(16), view.getUint32(20));
  }
  if (!startsWith(data, [0xff, 0xd8])) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1] ?? 0;
    if (marker === 0xff) {
      // A fill byte: the marker is the next byte.
      i += 1;
      continue;
    }
    // Markers with no length: SOI, TEM and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (JPEG_SOF.has(marker) && i + 9 <= data.length) {
      return sized(view.getUint16(i + 7), view.getUint16(i + 5));
    }
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}
