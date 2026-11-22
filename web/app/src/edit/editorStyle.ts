// The paragraph editor's colour and wheel rules (W6.8a 8a-1), kept out of the component so they can
// be tested without a DOM layout. The colour rules follow design section 7: the block's own colour
// when it reads on the editor's background, else the theme's text colour.
import type { ColorDto } from '../rpc/generated';

// The editor's background when the theme's token can't be read (the light theme's value).
export const FALLBACK_BACKGROUND = '#fff6c4';

function channel(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminanceOf(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOf(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;
  const n = Number.parseInt(match[1] ?? '', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
}

// The block's own colour when it reads on the background (3:1 at least), else the theme's text.
export function readableColour(color: ColorDto, background: string): string {
  const own = `rgb(${Math.round(color.r * 255)} ${Math.round(color.g * 255)} ${Math.round(color.b * 255)})`;
  const bg = parseHex(background);
  if (bg === null) return own;
  const contrast = contrastOf(luminanceOf([color.r, color.g, color.b]), luminanceOf(bg));
  return contrast >= 3 ? own : 'var(--color-text)';
}

// The editor's background: the theme token's value, read from the document, else the fallback.
export function backgroundFrom(computed: string): string {
  const value = computed.trim();
  return value === '' ? FALLBACK_BACKGROUND : value;
}

// Whether a textarea can scroll in the wheel's direction, so the wheel scrolls it rather than the
// page. `max` is how far it can scroll in total.
export function canScrollBy(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  deltaY: number,
): boolean {
  const max = scrollHeight - clientHeight;
  return deltaY < 0 ? scrollTop > 0 : scrollTop < max - 1;
}
