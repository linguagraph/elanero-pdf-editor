import { describe, expect, it } from 'vitest';
import { imageSize } from './imageSize';

// Builds the bytes of a PNG header: signature, IHDR chunk with the size, then nothing else.
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function concat(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

// A JPEG segment: the marker, then a length that counts itself and its payload.
function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

// A frame header with the given marker: precision, height, width, component count.
function frame(marker: number, width: number, height: number): number[] {
  return segment(marker, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
}

const SOI = [0xff, 0xd8];
const APP0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]);

describe('imageSize', () => {
  it('reads the size of a PNG from its IHDR header', () => {
    expect(imageSize(png(400, 200))).toEqual({ width: 400, height: 200 });
  });

  it('reads the size of a baseline JPEG', () => {
    expect(imageSize(concat(SOI, APP0, frame(0xc0, 640, 480)))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('reads the size of a progressive JPEG', () => {
    expect(imageSize(concat(SOI, APP0, frame(0xc2, 1200, 800)))).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it('skips fill bytes before a marker', () => {
    expect(imageSize(concat(SOI, [0xff, 0xff, 0xff], APP0, frame(0xc0, 30, 20)))).toEqual({
      width: 30,
      height: 20,
    });
  });

  it('returns null for data that is neither PNG nor JPEG', () => {
    expect(imageSize(new TextEncoder().encode('GIF89a not an image at all'))).toBeNull();
    expect(imageSize(new Uint8Array([]))).toBeNull();
  });

  it('returns null for a JPEG cut off before its frame header', () => {
    expect(imageSize(concat(SOI, APP0))).toBeNull();
  });

  it('returns null for a JPEG cut off inside its frame header', () => {
    expect(imageSize(concat(SOI, APP0, frame(0xc0, 640, 480).slice(0, 6)))).toBeNull();
  });

  it('returns null for a PNG cut off before its size', () => {
    expect(imageSize(png(400, 200).slice(0, 20))).toBeNull();
  });

  it('returns null for a zero width or height', () => {
    expect(imageSize(png(0, 200))).toBeNull();
    expect(imageSize(concat(SOI, APP0, frame(0xc0, 640, 0)))).toBeNull();
  });
});
