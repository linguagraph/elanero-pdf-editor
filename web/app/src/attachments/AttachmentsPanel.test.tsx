import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { AttachmentEntry } from '../rpc/generated';
import { AttachmentsPanel, saveName } from './AttachmentsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const files: AttachmentEntry[] = [
  { name: 'k1', filename: 'notes.txt', size: 1536, description: 'Reviewer notes' },
  { name: 'k2', filename: 'data.csv', size: 300, description: '' },
];

type Download = (name: string, bytes: ArrayBuffer, type?: string) => void;

// A fake engine: attachments.list and attachments.get answer as the given handlers say.
function fakeRpc(
  list: () => Promise<unknown>,
  get: () => Promise<unknown> = () => Promise.reject(),
) {
  const call = vi.fn((method: string) => (method === 'attachments.list' ? list() : get()));
  return { rpc: { call } as unknown as PageRpc, call };
}

const push = vi.fn<(kind: string, text: string) => number>(() => 1);
const store = { push } as unknown as ToastStore;

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function render(rpc: PageRpc, download: Download = vi.fn<Download>()) {
  act(() => {
    root.render(
      <AttachmentsPanel
        rpc={rpc}
        handle="h"
        onClose={() => undefined}
        store={store}
        download={download}
      />,
    );
  });
}

function items(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('.attachments-item')];
}

function press(element: HTMLElement | null): void {
  act(() => {
    element?.click();
  });
}

beforeEach(() => {
  push.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

describe('AttachmentsPanel', () => {
  it('lists the attachments from the attachments.list reply, with their sizes', async () => {
    const { rpc, call } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();

    expect(call).toHaveBeenCalledWith('attachments.list', { handle: 'h' });
    expect(items().map((item) => item.textContent)).toEqual([
      `notes.txt${t('attachments.size.kb', { value: '1.5' })}`,
      `data.csv${t('attachments.size.bytes', { count: 300 })}`,
    ]);
  });

  it('shows the empty state for a document with no attachments', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: [] }));
    render(rpc);
    await flush();

    expect(host.querySelector('.attachments-status')?.textContent).toBe(t('attachments.empty'));
    expect(items()).toHaveLength(0);
  });

  it('shows the selected file and saves its bytes through the download', async () => {
    const bytes = new Uint8Array([104, 105]).buffer;
    const { rpc, call } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.resolve({ filename: 'notes.txt', data: bytes }),
    );
    const download = vi.fn<Download>();
    render(rpc, download);
    await flush();

    press(items()[0] ?? null);
    expect(items()[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.attachments-details')?.textContent).toContain('Reviewer notes');
    press(host.querySelector<HTMLButtonElement>('.attachments-save'));
    await flush();

    expect(call).toHaveBeenCalledWith('attachments.get', { handle: 'h', name: 'k1' });
    expect(download).toHaveBeenCalledWith('notes.txt', bytes, 'application/octet-stream');
  });

  it('shows the no-description text for a file without one', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();

    press(items()[1] ?? null);
    expect(host.querySelector('.attachments-details')?.textContent).toContain(
      t('attachments.noDescription'),
    );
  });

  it('shows a load failure through t()', async () => {
    const { rpc } = fakeRpc(() => Promise.reject(new Error('boom')));
    render(rpc);
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('attachments.loadFailed'));
  });

  it('reports a failed save as a toast through t()', async () => {
    const { rpc } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.reject(new Error('disk gone')),
    );
    const download = vi.fn<Download>();
    render(rpc, download);
    await flush();

    press(items()[0] ?? null);
    press(host.querySelector<HTMLButtonElement>('.attachments-save'));
    await flush();

    expect(download).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('error', t('attachments.saveFailed'));
  });

  it('reports a refused save through the RPC error mapping', async () => {
    const { rpc } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.reject(new RpcError('STALE_OBJECT', 'gone')),
    );
    render(rpc);
    await flush();

    press(items()[0] ?? null);
    press(host.querySelector<HTMLButtonElement>('.attachments-save'));
    await flush();

    expect(push.mock.calls[0]?.[0]).toBe('error');
    expect(push.mock.calls[0]?.[1]).toContain('changed');
  });
});

describe('saveName', () => {
  it('keeps the last part of a declared path, without control characters', () => {
    expect(saveName('reports/2026\\q1.pdf')).toBe('q1.pdf');
    expect(saveName('bad\u0001name.txt')).toBe('badname.txt');
    expect(saveName('..')).toBe('attachment');
  });
});
