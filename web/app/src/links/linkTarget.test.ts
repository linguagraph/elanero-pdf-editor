import { describe, expect, it } from 'vitest';
import type { LinkDto } from '../rpc/generated';
import { classifyLink } from './linkTarget';

function link(overrides: Partial<LinkDto>): LinkDto {
  return {
    rect: { x0: 10, y0: 10, x1: 50, y1: 20 },
    kind: 'goto',
    page: 3,
    top: null,
    uri: '',
    ...overrides,
  };
}

describe('classifyLink', () => {
  it('jumps to the target page of a goto link, with its top when it gives one', () => {
    expect(classifyLink(link({ page: 3 }))).toEqual({ action: 'goto', page: 3, top: null });
    expect(classifyLink(link({ page: 0, top: 120 }))).toEqual({
      action: 'goto',
      page: 0,
      top: 120,
    });
  });

  it('gives the no-destination notice for a goto link without a page', () => {
    expect(classifyLink(link({ page: null }))).toEqual({ action: 'notice', notice: 'noTarget' });
  });

  it('treats every other kind as unsupported, including a kind it does not know', () => {
    expect(classifyLink(link({ kind: 'unsupported', page: null }))).toEqual({
      action: 'notice',
      notice: 'unsupported',
    });
    expect(classifyLink(link({ kind: 'launch', page: 1 }))).toEqual({
      action: 'notice',
      notice: 'unsupported',
    });
  });
});

describe('classifyLink, URI links', () => {
  const uri = (text: string) => classifyLink(link({ kind: 'uri', uri: text }));

  it.each([
    ['https://example.org/', 'https://example.org/', 'https:', 'example.org'],
    ['HTTP://EXAMPLE.ORG', 'http://example.org/', 'http:', 'example.org'],
    ['  https://example.org/x  ', 'https://example.org/x', 'https:', 'example.org'],
    ['mailto:a@example.org', 'mailto:a@example.org', 'mailto:', ''],
    // The host shown is the one the browser would reach, not the part before the "@".
    [
      'https://bank.example@evil.example/',
      'https://bank.example@evil.example/',
      'https:',
      'evil.example',
    ],
    // The parser punycodes the host, so a look-alike shows as what it really is.
    [
      'https://bücher.example/',
      'https://xn--bcher-kva.example/',
      'https:',
      'xn--bcher-kva.example',
    ],
    // Non-ASCII in the path is percent-encoded, so the shown and the opened address agree.
    ['https://example.org/\u202Eabc', 'https://example.org/%E2%80%AEabc', 'https:', 'example.org'],
  ])('confirms %j, opening %j on host %j', (text, href, scheme, host) => {
    expect(uri(text)).toEqual({ action: 'confirm', href, scheme, host });
  });

  it('confirms a 2048-character address', () => {
    const text = `https://example.org/${'a'.repeat(2028)}`;
    expect(uri(text)).toMatchObject({ action: 'confirm', host: 'example.org' });
  });

  it.each([
    ['javascript:alert(1)', 'javascript'],
    ['JaVaScRiPt:x', 'javascript'],
    ['java\tscript:x', 'javascript'],
    ['java\nscript:x', 'javascript'],
    [' javascript:x', 'javascript'],
    ['data:text/html,x', 'data'],
    ['file:///C:/x', 'file'],
    ['blob:https://example.org/x', 'blob'],
    ['vbscript:x', 'vbscript'],
    ['ftp://x', 'ftp'],
    ['intent://x', 'intent'],
    [`${'a'.repeat(30)}:x`, 'a'.repeat(20)],
  ])('blocks %j, naming the scheme %j', (text, scheme) => {
    expect(uri(text)).toEqual({ action: 'notice', notice: 'blocked', scheme });
  });

  it.each(['www.example.org', '/a', '#x', 'https://', 'http:///x', 'mailto:', '', '   '])(
    'treats %j as malformed',
    (text) => {
      expect(uri(text)).toEqual({ action: 'notice', notice: 'malformed' });
    },
  );

  it('treats a uri link with no address as malformed', () => {
    expect(classifyLink(link({ kind: 'uri', uri: '' }))).toEqual({
      action: 'notice',
      notice: 'malformed',
    });
  });
});
