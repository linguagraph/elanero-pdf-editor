import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { DocumentView } from './DocumentView';
import type { ViewTool } from './viewTool';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// session.pages answers at once; actions.run waits until the test resolves it (one add in flight).
interface Pending {
  readonly resolve: (value: unknown) => void;
}

function fakeRpc(pending: Pending[]): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792, rotation: 0 })),
          labels: [],
        });
      }
      if (method === 'actions.run') {
        return new Promise((resolve) => pending.push({ resolve }));
      }
      return new Promise(() => {});
    }),
  };
  return rpc as unknown as PageRpc;
}

const ADDED = { executed: true, changed: { revisions: {} }, state: { history: 1 } };

let host: HTMLDivElement;
let root: Root;
let pending: Pending[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  pending = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Props {
  readonly tool: ViewTool;
  readonly tabId: number;
  readonly onToolChange: (tool: ViewTool, tabId?: number | null) => void;
}

function view(props: Props, rpc: PageRpc) {
  return (
    <DocumentView
      rpc={rpc}
      handle="h"
      tool={props.tool}
      tabId={props.tabId}
      onToolChange={props.onToolChange}
    />
  );
}

async function mount(props: Props, rpc: PageRpc): Promise<void> {
  act(() => {
    root.render(view(props, rpc));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rerender(props: Props, rpc: PageRpc): void {
  act(() => {
    root.render(view(props, rpc));
  });
}

function enter(): void {
  const layer = host.querySelector('.shape-layer');
  if (layer === null) throw new Error('no shape layer');
  act(() => {
    layer.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });
}

async function settle(index: number, value: unknown): Promise<void> {
  const entry = pending[index];
  if (entry === undefined) throw new Error(`no pending add ${index}`);
  await act(async () => {
    entry.resolve(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function addCalls(rpc: PageRpc): number {
  return vi.mocked(rpc.call).mock.calls.filter(([method]) => method === 'actions.run').length;
}

describe('DocumentView shape gestures (W6.7b)', () => {
  it('a shape added on tab 1 resets tab 1 to Select, and leaves tab 2 alone after a switch', async () => {
    const rpc = fakeRpc(pending);
    const tools = new Map<number, ViewTool>([
      [1, 'shape-rectangle'],
      [2, 'shape-ellipse'],
    ]);
    const onToolChange = (tool: ViewTool, tabId?: number | null) => {
      if (tabId !== undefined && tabId !== null) tools.set(tabId, tool);
    };
    await mount({ tool: 'shape-rectangle', tabId: 1, onToolChange }, rpc);
    enter();
    // The user switches to tab 2 while the add is still in flight.
    rerender({ tool: 'shape-ellipse', tabId: 2, onToolChange }, rpc);
    await settle(0, ADDED);
    expect(tools.get(1)).toBe('select');
    expect(tools.get(2)).toBe('shape-ellipse');
  });

  it('a second Enter while the first add is in flight adds nothing more', async () => {
    const rpc = fakeRpc(pending);
    const onToolChange = vi.fn();
    await mount({ tool: 'shape-rectangle', tabId: 1, onToolChange }, rpc);
    enter();
    enter();
    expect(addCalls(rpc)).toBe(1);
    await settle(0, ADDED);
    expect(onToolChange).toHaveBeenCalledWith('select', 1);
  });

  it('a new gesture is accepted again once the first add has settled', async () => {
    const rpc = fakeRpc(pending);
    const onToolChange = vi.fn();
    await mount({ tool: 'shape-rectangle', tabId: 1, onToolChange }, rpc);
    enter();
    await settle(0, { ...ADDED, executed: false });
    enter();
    expect(addCalls(rpc)).toBe(2);
  });
});
