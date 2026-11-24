import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionJobCancelled, runActionJob } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { pickFile } from '../files/pickFile';
import type { ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { AttachmentEntry } from '../rpc/generated';
import { AttachmentsPanel, saveName } from './AttachmentsPanel';
import { MAX_ATTACHMENT_BYTES } from './attachmentActions';

vi.mock('../files/pickFile', () => ({ pickFile: vi.fn() }));
vi.mock('../actionJob/actionJob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../actionJob/actionJob')>();
  return { ...actual, runActionJob: vi.fn() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape: (value: string) => value.replace(/[^\w-]/g, (char) => String.fromCharCode(92) + char),
    },
  });
}

const files: AttachmentEntry[] = [
  { name: 'k1', filename: 'notes.txt', size: 1536, description: 'Reviewer notes' },
  { name: 'k2', filename: 'data.csv', size: 300, description: '' },
];

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n%test\n').buffer;
const TEXT_BYTES = new TextEncoder().encode('hello').buffer;

type Download = (name: string, bytes: ArrayBuffer, type?: string) => void;

// A fake engine: attachments.list and attachments.get answer as the given handlers say; any other
// method (actions.run) answers with `run`.
function fakeRpc(
  list: () => Promise<unknown>,
  get: () => Promise<unknown> = () => Promise.reject(),
  run: () => Promise<unknown> = () => Promise.reject(new Error('unexpected actions.run')),
) {
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
    if (method === 'attachments.list') return list();
    if (method === 'attachments.get') return get();
    return run();
  });
  return { rpc: { call } as unknown as PageRpc, call };
}

const push = vi.fn<(kind: string, text: string, options?: unknown) => number>(() => 1);
const store = { push } as unknown as ToastStore;

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface RenderOptions {
  download?: Download;
  signed?: boolean;
  revision?: number;
  onOpenFiles?: (files: readonly File[]) => void;
}

function element(rpc: PageRpc, options: RenderOptions = {}) {
  return (
    <AttachmentsPanel
      rpc={rpc}
      handle="h"
      onClose={() => undefined}
      store={store}
      download={options.download ?? vi.fn<Download>()}
      revision={options.revision ?? 0}
      signed={options.signed ?? false}
      onHistoryStep={vi.fn()}
      startWorker={vi.fn(() => ({ call: vi.fn(), terminate: vi.fn() }))}
      onOpenFiles={options.onOpenFiles ?? vi.fn()}
    />
  );
}

function render(rpc: PageRpc, options: RenderOptions = {}) {
  act(() => {
    root.render(element(rpc, options));
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

// The dialog is portaled to the body, so its buttons are found there (not the panel's own button,
// which has the same text).
function bodyButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.redact-confirm button')].find(
    (button) => button.textContent === text,
  );
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
  vi.mocked(pickFile).mockReset();
  vi.mocked(runActionJob).mockReset();
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

  it('shows the empty state for a document with no attachments, with Add still there', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: [] }));
    render(rpc);
    await flush();

    expect(host.querySelector('.attachments-status')?.textContent).toBe(t('attachments.empty'));
    expect(items()).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>('.attachments-add')?.disabled).toBe(false);
  });

  it('shows the selected file and saves its bytes through the download', async () => {
    const bytes = new Uint8Array([104, 105]).buffer;
    const { rpc, call } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.resolve({ filename: 'notes.txt', data: bytes }),
    );
    const download = vi.fn<Download>();
    render(rpc, { download });
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
    render(rpc, { download });
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

  it('reloads the list when the revision changes (an Undo or Redo)', async () => {
    const { rpc, call } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc, { revision: 0 });
    await flush();
    render(rpc, { revision: 1 });
    await flush();

    expect(call.mock.calls.filter(([method]) => method === 'attachments.list')).toHaveLength(2);
  });

  it('disables Add and Remove on a signed document and says why', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc, { signed: true });
    await flush();
    press(items()[0] ?? null);

    expect(host.querySelector<HTMLButtonElement>('.attachments-add')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.attachments-remove')?.disabled).toBe(true);
    expect(host.querySelector('.attachments-hint')?.textContent).toBe(t('attachments.signedHint'));
  });
});

describe('AttachmentsPanel: add', () => {
  it('embeds the picked file through actions.run and reloads the list', async () => {
    const picked = new File([new Uint8Array([1, 2, 3])], 'notes.txt');
    vi.mocked(pickFile).mockResolvedValue(picked);
    const { rpc, call } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.reject(new Error('unused')),
      () =>
        Promise.resolve({
          label: 'Add Attachment',
          executed: true,
          value: 'notes (2).txt',
          changed: null,
          state: { history: 4 },
        }),
    );
    render(rpc);
    await flush();

    press(host.querySelector<HTMLButtonElement>('.attachments-add'));
    await flush();

    const run = call.mock.calls.find(([method]) => method === 'actions.run');
    expect(run).toBeDefined();
    expect(run?.[1]).toMatchObject({
      handle: 'h',
      name: 'attachments.add',
      args: { filename: 'notes.txt', description: '' },
    });
    const sent = run?.[1] as { args: { data: ArrayBuffer } };
    expect(Array.from(new Uint8Array(sent.args.data))).toEqual([1, 2, 3]);
    expect(call.mock.calls.filter(([method]) => method === 'attachments.list')).toHaveLength(2);
    expect(push).toHaveBeenCalledWith(
      'info',
      t('attachments.added', { name: 'notes (2).txt' }),
      expect.anything(),
    );
  });

  it('refuses a file over the cap before it reads the bytes', async () => {
    const big = new File([new Uint8Array([1])], 'big.bin');
    Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
    vi.mocked(pickFile).mockResolvedValue(big);
    const { rpc, call } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();

    press(host.querySelector<HTMLButtonElement>('.attachments-add'));
    await flush();

    expect(call.mock.calls.some(([method]) => method === 'actions.run')).toBe(false);
    expect(push).toHaveBeenCalledWith('error', t('attachments.tooLarge', { mb: 100 }));
  });

  it('does nothing when the picker is cancelled', async () => {
    vi.mocked(pickFile).mockResolvedValue(null);
    const { rpc, call } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();

    press(host.querySelector<HTMLButtonElement>('.attachments-add'));
    await flush();

    expect(call.mock.calls.some(([method]) => method === 'actions.run')).toBe(false);
  });
});

describe('AttachmentsPanel: remove', () => {
  it('asks first, then removes the entry as a job and reloads', async () => {
    vi.mocked(runActionJob).mockResolvedValue({
      label: 'Remove Attachment',
      changed: null,
      value: null,
      history: 5,
    });
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();
    press(items()[0] ?? null);

    press(host.querySelector<HTMLButtonElement>('.attachments-remove'));
    expect(document.body.textContent).toContain(
      t('attachments.remove.body', { name: 'notes.txt' }),
    );
    expect(runActionJob).not.toHaveBeenCalled();

    press(bodyButton(t('attachments.remove.confirm')) ?? null);
    await flush();

    expect(runActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ engine: expect.anything() }),
      'h',
      'attachments.remove',
      { name: 'k1' },
    );
    expect(push).toHaveBeenCalledWith(
      'info',
      t('attachments.removed', { name: 'notes.txt' }),
      expect.anything(),
    );
  });

  it('cancel in the dialog removes nothing', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();
    press(items()[0] ?? null);
    press(host.querySelector<HTMLButtonElement>('.attachments-remove'));

    press(bodyButton(t('attachments.remove.cancel')) ?? null);
    await flush();

    expect(runActionJob).not.toHaveBeenCalled();
  });

  it('shows the stale message, and no Undo toast, when the document changed under the remove', async () => {
    vi.mocked(runActionJob).mockRejectedValue(new RpcError('STALE_OBJECT', 'x'));
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();
    press(items()[0] ?? null);
    press(host.querySelector<HTMLButtonElement>('.attachments-remove'));
    press(bodyButton(t('attachments.remove.confirm')) ?? null);
    await flush();

    expect(push).toHaveBeenCalledWith('info', t('attachments.stale'));
    expect(push.mock.calls.some(([, , options]) => options !== undefined)).toBe(false);
  });

  it('shows nothing when the user cancels the remove job', async () => {
    vi.mocked(runActionJob).mockRejectedValue(new ActionJobCancelled());
    const { rpc } = fakeRpc(() => Promise.resolve({ entries: files }));
    render(rpc);
    await flush();
    press(items()[0] ?? null);
    press(host.querySelector<HTMLButtonElement>('.attachments-remove'));
    press(bodyButton(t('attachments.remove.confirm')) ?? null);
    await flush();

    expect(runActionJob).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('AttachmentsPanel: open', () => {
  it('shows Open only for a PDF attachment and opens it as a new file', async () => {
    const onOpenFiles = vi.fn<(files: readonly File[]) => void>();
    const { rpc } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.resolve({ filename: 'manual.pdf', data: PDF_BYTES }),
    );
    render(rpc, { onOpenFiles });
    await flush();
    press(items()[0] ?? null);
    await flush();

    const open = host.querySelector<HTMLButtonElement>('.attachments-open');
    expect(open).not.toBeNull();
    press(open);
    await flush();

    const opened = onOpenFiles.mock.calls[0]?.[0] ?? [];
    expect(opened).toHaveLength(1);
    expect(opened[0]?.name).toBe('manual.pdf');
    expect(opened[0]?.type).toBe('application/pdf');
  });

  it('does not offer Open for a file that is not a PDF', async () => {
    const { rpc } = fakeRpc(
      () => Promise.resolve({ entries: files }),
      () => Promise.resolve({ filename: 'notes.txt', data: TEXT_BYTES }),
    );
    render(rpc);
    await flush();
    press(items()[0] ?? null);
    await flush();

    expect(host.querySelector('.attachments-open')).toBeNull();
    expect(host.querySelector('.attachments-save')).not.toBeNull();
  });
});

describe('saveName', () => {
  it('keeps the last part of a declared path, without control characters', () => {
    expect(saveName('reports/2026\\q1.pdf')).toBe('q1.pdf');
    expect(saveName('bad\u0001name.txt')).toBe('badname.txt');
    expect(saveName('..')).toBe('attachment');
  });
});
