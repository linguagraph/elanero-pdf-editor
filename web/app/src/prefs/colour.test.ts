import { describe, expect, it } from 'vitest';
import { hexToColorJson } from './colour';

describe('hexToColorJson (W4.5 S3)', () => {
  it('maps each 8-bit channel to 0..1 with four decimals', () => {
    expect(hexToColorJson('#ff8000')).toEqual({ r: 1, g: 0.502, b: 0 });
    expect(hexToColorJson('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToColorJson('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
  });

  it('reads upper-case digits too', () => {
    expect(hexToColorJson('#ABCDEF')).toEqual({ r: 0.6706, g: 0.8039, b: 0.9373 });
  });
});
