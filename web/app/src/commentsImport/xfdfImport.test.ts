import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import {
  importedCount,
  importXfdf,
  MAX_XFDF_BYTES,
  previewXfdf,
  readXfdf,
  XfdfTooLarge,
} from './xfdfImport';

function fileOfSize(size: number): File {
  const file = new File(['<xfdf/>'], 'review.xfdf', { type: 'application/vnd.adobe.xfdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('readXfdf', () => {
  it('refuses an oversize file before reading it', async () => {
    const file = fileOfSize(MAX_XFDF_BYTES + 1);
    const text = vi.spyOn(file, 'text');
    await expect(readXfdf(file)).rejects.toBeInstanceOf(XfdfTooLarge);
    expect(text).not.toHaveBeenCalled();
  });

  it('reads a file at the limit', async () => {
    const file = new File(['<xfdf/>'], 'review.xfdf');
    Object.defineProperty(file, 'size', { value: MAX_XFDF_BYTES });
    await expect(readXfdf(file)).resolves.toBe('<xfdf/>');
  });
});

describe('the engine calls', () => {
  it('previews through comments.xfdf_preview with the text', async () => {
    const call = vi.fn(async () => ({ comments: 2, replies: 1, pages: [0] }));
    const rpc = { call, chunked: vi.fn() } as unknown as PageRpc;
    await expect(previewXfdf(rpc, 'h1', '<xfdf/>')).resolves.toEqual({
      comments: 2,
      replies: 1,
      pages: [0],
    });
    expect(call).toHaveBeenCalledWith('comments.xfdf_preview', { handle: 'h1', text: '<xfdf/>' });
  });

  it('imports through actions.run with annotations.import_xfdf', async () => {
    const call = vi.fn(async () => ({ label: 'Import 2 Comments', value: 2 }));
    const rpc = { call, chunked: vi.fn() } as unknown as PageRpc;
    await importXfdf(rpc, 'h1', '<xfdf/>');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.import_xfdf',
      args: { text: '<xfdf/>' },
    });
  });

  it('reads the imported count only from a number', () => {
    expect(importedCount(3)).toBe(3);
    expect(importedCount(null)).toBe(0);
  });
});
