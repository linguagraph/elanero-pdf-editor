import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { LayerEntry } from '../rpc/generated';
import { LayersPanel } from './LayersPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const layers: LayerEntry[] = [
  { id: 7, name: 'Background', visible: true, depth: 0, locked: false },
  { id: 9, name: 'Stamps', visible: false, depth: 1, locked: true },
];

// A fake engine: layers.list and layers.set_visible answer as the given handlers say.
function fakeRpc(
  list: () => Promise<unknown>,
  setVisible: (args: unknown) => Promise<unknown> = () => Promise.reject(new Error('unexpected')),
) {
  const call = vi.fn((method: string, args: unknown) => {
    if (method === 'layers.list') return list();
    if (method === 'layers.set_visible') return setVisible(args);
    throw new Error(`unexpected call ${method}`);
  });
  return { rpc: { call } as unknown as PageRpc, call };
}

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function render(rpc: PageRpc, revision = 0) {
  act(() => {
    root.render(<LayersPanel rpc={rpc} handle="h" revision={revision} onClose={() => undefined} />);
  });
}

function boxes(): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('.layers-check')];
}

function rows(): HTMLLIElement[] {
  return [...host.querySelectorAll<HTMLLIElement>('.layers-item')];
}

beforeEach(() => {
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

describe('LayersPanel', () => {
  it('lists the layers from the layers.list reply, in order, with visibility and lock state', async () => {
    const { rpc, call } = fakeRpc(() => Promise.resolve({ layers }));
    render(rpc);
    await flush();

    expect(call).toHaveBeenCalledWith('layers.list', { handle: 'h' });
    expect(rows().map((row) => row.querySelector('.layers-name')?.textContent)).toEqual([
      'Background',
      'Stamps',
    ]);
    expect(rows()[0]?.textContent).toContain(t('layers.visible'));
    expect(rows()[0]?.querySelector('.layers-locked')).toBeNull();
    expect(rows()[1]?.textContent).toContain(t('layers.hidden'));
    expect(rows()[1]?.querySelector('.layers-locked')?.textContent).toBe(t('layers.locked'));
  });

  it('indents a nested layer by its depth and shows a blank name as unnamed', async () => {
    const { rpc } = fakeRpc(() =>
      Promise.resolve({
        layers: [
          { id: 1, name: '', visible: true, depth: 0, locked: false },
          { id: 2, name: 'Deep', visible: true, depth: 9, locked: false },
        ],
      }),
    );
    render(rpc);
    await flush();

    expect(rows()[0]?.querySelector('.layers-name')?.textContent).toBe(t('layers.unnamed'));
    expect(rows()[1]?.classList.contains('layers-indent-5')).toBe(true);
  });

  it('shows the empty state for a document without layers', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ layers: [] }));
    render(rpc);
    await flush();

    expect(host.querySelector('.layers-status')?.textContent).toBe(t('layers.empty'));
    expect(rows()).toHaveLength(0);
  });

  it('shows a load failure through t()', async () => {
    const { rpc } = fakeRpc(() => Promise.reject(new RpcError('STALE_OBJECT', 'gone')));
    render(rpc);
    await flush();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('layers.loadFailed'));
    expect(rows()).toHaveLength(0);
  });

  it('shows each layer as a checkbox that follows its visibility, and disables a locked one', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve({ layers }));
    render(rpc);
    await flush();

    expect(boxes().map((box) => box.checked)).toEqual([true, false]);
    expect(boxes().map((box) => box.disabled)).toEqual([false, true]);
  });

  it('sends the new state and shows the list the reply carries', async () => {
    const after = [{ ...layers[0], visible: false }, layers[1]];
    const { rpc, call } = fakeRpc(
      () => Promise.resolve({ layers }),
      () => Promise.resolve({ layers: after }),
    );
    render(rpc);
    await flush();

    act(() => {
      boxes()[0]?.click();
    });
    await flush();

    expect(call).toHaveBeenCalledWith('layers.set_visible', { handle: 'h', id: 7, visible: false });
    expect(rows()[0]?.textContent).toContain(t('layers.hidden'));
    expect(boxes()[0]?.checked).toBe(false);
  });

  it('keeps the list and shows the refusal when the engine refuses the change', async () => {
    const push = vi.spyOn(toasts, 'push');
    const { rpc } = fakeRpc(
      () => Promise.resolve({ layers }),
      () => Promise.reject(new RpcError('REFUSED', 'locked', { reason: 'layer_locked' })),
    );
    render(rpc);
    await flush();

    act(() => {
      boxes()[0]?.click();
    });
    await flush();

    expect(boxes()[0]?.checked).toBe(true);
    expect(push.mock.calls[0]?.slice(0, 2)).toEqual(['error', t('error.REFUSED.layerLocked')]);
  });

  it('reads the list again when the revision changes', async () => {
    const { rpc, call } = fakeRpc(() => Promise.resolve({ layers }));
    render(rpc, 0);
    await flush();
    render(rpc, 1);
    await flush();

    expect(call.mock.calls.filter(([method]) => method === 'layers.list')).toHaveLength(2);
  });

  it('reads the list again and toasts when the toggle finds the list stale', async () => {
    const push = vi.spyOn(toasts, 'push');
    const { rpc, call } = fakeRpc(
      () => Promise.resolve({ layers }),
      () => Promise.reject(new RpcError('STALE_OBJECT', 'gone')),
    );
    render(rpc);
    await flush();

    act(() => {
      boxes()[0]?.click();
    });
    await flush();

    expect(call.mock.calls.filter(([method]) => method === 'layers.list')).toHaveLength(2);
    expect(push).toHaveBeenCalled();
    expect(push.mock.calls[0]?.[0]).toBe('error');
  });

  it('shows layers.toggleFailed and keeps the list on a non-RPC failure', async () => {
    const push = vi.spyOn(toasts, 'push');
    const { rpc } = fakeRpc(
      () => Promise.resolve({ layers }),
      () => Promise.reject(new Error('x')),
    );
    render(rpc);
    await flush();

    act(() => {
      boxes()[0]?.click();
    });
    await flush();

    expect(push).toHaveBeenCalledWith('error', t('layers.toggleFailed'));
    expect(boxes()[0]?.checked).toBe(true);
    expect(boxes()[0]?.disabled).toBe(false);
  });

  it('ignores a second toggle while one is in flight and disables the boxes', async () => {
    const open: LayerEntry[] = [
      { id: 1, name: 'A', visible: true, depth: 0, locked: false },
      { id: 2, name: 'B', visible: true, depth: 0, locked: false },
    ];
    let finish: (reply: unknown) => void = () => undefined;
    const { rpc, call } = fakeRpc(
      () => Promise.resolve({ layers: open }),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(rpc);
    await flush();

    act(() => {
      boxes()[0]?.click();
    });
    await flush();
    act(() => {
      boxes()[1]?.click();
    });
    await flush();

    const setCalls = call.mock.calls.filter(([method]) => method === 'layers.set_visible');
    expect(setCalls).toHaveLength(1);
    expect(boxes().map((box) => box.disabled)).toEqual([true, true]);

    await act(async () => {
      finish({ layers: [{ ...open[0], visible: false }, open[1]] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(boxes().map((box) => box.disabled)).toEqual([false, false]);
  });

  it('does not send a change for a locked layer when its checkbox is clicked', async () => {
    const { rpc, call } = fakeRpc(() => Promise.resolve({ layers }));
    render(rpc);
    await flush();

    act(() => {
      boxes()[1]?.click();
    });
    await flush();

    expect(call.mock.calls.filter(([method]) => method === 'layers.set_visible')).toHaveLength(0);
    expect(boxes()[1]?.checked).toBe(false);
  });
});
