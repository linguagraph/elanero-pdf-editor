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
    expect(classifyLink(link({ kind: 'uri', uri: 'https://example.org/' }))).toEqual({
      action: 'notice',
      notice: 'unsupported',
    });
    expect(classifyLink(link({ kind: 'launch', page: 1 }))).toEqual({
      action: 'notice',
      notice: 'unsupported',
    });
  });
});
