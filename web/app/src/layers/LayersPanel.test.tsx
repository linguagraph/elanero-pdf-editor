import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { LayerEntry } from '../rpc/generated';
import { LayersPanel } from './LayersPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const layers: LayerEntry[] = [
  { id: 7, name: 'Background', visible: true, depth: 0, locked: false },
  { id: 9, name: 'Stamps', visible: false, depth: 1, locked: true },
];

// A fake engine: layers.list answers as the given handler says.
function fakeRpc(list: () => Promise<unknown>) {
  const call = vi.fn((method: string) => {
    if (method !== 'layers.list') throw new Error(`unexpected call ${method}`);
    return list();
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

function render(rpc: PageRpc) {
  act(() => {
    root.render(<LayersPanel rpc={rpc} handle="h" onClose={() => undefined} />);
  });
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
});
