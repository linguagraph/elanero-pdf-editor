import { describe, expect, it } from 'vitest';
import { parseMegabytes, parsePagesPerFile, parseRanges } from './ranges';

describe('parseRanges', () => {
  it('reads "1-3, 5" as the pages 1, 2, 3 and 5, one part per item, 0-based', () => {
    const result = parseRanges('1-3, 5', 10);
    expect(result).toEqual({
      ok: true,
      parts: [[0, 1, 2], [4]],
    });
  });

  it('accepts a single page and spacing around the dash', () => {
    expect(parseRanges(' 2 ', 3)).toEqual({ ok: true, parts: [[1]] });
    expect(parseRanges('1 - 2', 3)).toEqual({ ok: true, parts: [[0, 1]] });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
  ])('refuses %j as empty', (text, kind) => {
    expect(parseRanges(text, 10)).toEqual({ ok: false, error: { kind } });
  });

  it.each(['a', '1,,2', '1-', '-3', '1.5', '3-1', '1,2,'])('refuses %j as invalid', (text) => {
    const result = parseRanges(text, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid');
  });

  it.each(['0', '11', '9-12', '0-2'])('refuses %j as outside a 10-page document', (text) => {
    expect(parseRanges(text, 10)).toMatchObject({
      ok: false,
      error: { kind: 'outOfRange', item: text, count: 10 },
    });
  });
});

describe('parsePagesPerFile', () => {
  it('takes a whole number from 1 to the page count', () => {
    expect(parsePagesPerFile('1', 10)).toBe(1);
    expect(parsePagesPerFile(' 10 ', 10)).toBe(10);
    expect(parsePagesPerFile('0', 10)).toBeNull();
    expect(parsePagesPerFile('11', 10)).toBeNull();
    expect(parsePagesPerFile('2.5', 10)).toBeNull();
    expect(parsePagesPerFile('', 10)).toBeNull();
  });
});

describe('parseMegabytes', () => {
  it('turns a positive number of megabytes into bytes', () => {
    expect(parseMegabytes('1')).toBe(1024 * 1024);
    expect(parseMegabytes('0.5')).toBe(524288);
  });

  it.each(['0', '-1', 'big', ''])('refuses %j', (text) => {
    expect(parseMegabytes(text)).toBeNull();
  });
});
