// Colour conversion for the redaction mark style (W4.5 S3). The preferences keep #rrggbb text (what
// the colour input gives); the engine takes each channel as a number from 0 to 1 (model/color.py).
export interface ColorJson {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

// Four decimals are enough for an 8-bit channel (255 steps), and keep the wire form short.
const DECIMALS = 10000;

function channel(hex: string, start: number): number {
  const value = parseInt(hex.slice(start, start + 2), 16) / 255;
  return Math.round(value * DECIMALS) / DECIMALS;
}

// '#ff8000' gives {r: 1, g: 0.502, b: 0}. The input must already be #rrggbb (cleanHexColour).
export function hexToColorJson(hex: string): ColorJson {
  return { r: channel(hex, 1), g: channel(hex, 3), b: channel(hex, 5) };
}
