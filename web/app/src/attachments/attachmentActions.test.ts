import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { isPdfBytes, openPdfAttachment } from './attachmentActions';

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('isPdfBytes', () => {
  it('recognises the PDF marker at the start', () => {
    expect(isPdfBytes(bytesOf('%PDF-1.4\n...'))).toBe(true);
  });

  it('accepts junk before the marker when it is in the first kilobyte', () => {
    expect(isPdfBytes(bytesOf(`${'x'.repeat(200)}%PDF-1.4`))).toBe(true);
  });

  it('rejects a marker after the first kilobyte, an empty file and other types', () => {
    expect(isPdfBytes(bytesOf(`${'x'.repeat(2000)}%PDF-1.4`))).toBe(false);
    expect(isPdfBytes(new ArrayBuffer(0))).toBe(false);
    expect(isPdfBytes(bytesOf('hello'))).toBe(false);
  });
});

describe('openPdfAttachment', () => {
  it('refuses a non-PDF with a message and opens nothing', async () => {
    const push = vi.fn<(kind: string, text: string) => number>(() => 1);
    const store = { push } as unknown as ToastStore;
    const rpc = {
      call: vi.fn(() => Promise.resolve({ filename: 'notes.txt', data: bytesOf('plain') })),
    } as unknown as PageRpc;
    const openFiles = vi.fn<(files: readonly File[]) => void>();

    await openPdfAttachment(
      { rpc, handle: 'h', store },
      { name: 'k1', filename: 'notes.txt', size: 5, description: '' },
      openFiles,
    );

    expect(openFiles).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('error', t('attachments.openFailed'));
  });

  it('opens a PDF as one File named by its last path part, typed as a PDF', async () => {
    const store = { push: vi.fn(() => 1) } as unknown as ToastStore;
    const rpc = {
      call: vi.fn(() =>
        Promise.resolve({ filename: '../x/brief.pdf', data: bytesOf('%PDF-1.4\n...') }),
      ),
    } as unknown as PageRpc;
    const openFiles = vi.fn<(files: readonly File[]) => void>();

    await openPdfAttachment(
      { rpc, handle: 'h', store },
      { name: 'k1', filename: '../x/brief.pdf', size: 12, description: '' },
      openFiles,
    );

    expect(openFiles).toHaveBeenCalledTimes(1);
    const [files] = openFiles.mock.calls[0] ?? [];
    expect(files).toHaveLength(1);
    expect(files?.[0]?.name).toBe('brief.pdf');
    expect(files?.[0]?.type).toBe('application/pdf');
  });
});
