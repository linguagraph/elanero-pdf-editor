import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { t } from '../i18n/t';
import { DocumentStatusBar } from './DocumentStatusBar';
import { DocumentView, type DocumentViewHandle, type DocumentViewState } from './DocumentView';
import { DEFAULT_ZOOM } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fake engine that answers session.pages with the given labels and leaves everything else
// unanswered: the labels are all these tests look at.
function fakeRpc(pageCount: number, labels: readonly string[]): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: pageCount }, () => ({
            width: 612,
            height: 792,
            rotation: 0,
          })),
          labels: [...labels],
        });
      }
      return new Promise(() => undefined);
    }),
  };
  return rpc as unknown as PageRpc;
}

// Wires the view to the status bar the way App does (W5.3b): the view reports its state, the
// status bar shows the labels, and a jump from the field goes back to the view.
function Reader({ rpc, total, jumps }: { rpc: PageRpc; total: number; jumps: number[] }) {
  const [viewState, setViewState] = useState<DocumentViewState>({
    page: 1,
    zoom: DEFAULT_ZOOM,
    layout: 'continuous',
    labels: [],
  });
  const viewRef = useRef<DocumentViewHandle>(null);
  return (
    <>
      <DocumentStatusBar
        page={viewState.page}
        total={total}
        zoom={viewState.zoom}
        layout={viewState.layout}
        labels={viewState.labels}
        canBack={false}
        canForward={false}
        onGoTo={(index) => {
          jumps.push(index);
          viewRef.current?.scrollToPage(index);
        }}
        onBack={() => undefined}
        onForward={() => undefined}
      />
      <DocumentView ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={setViewState} />
    </>
  );
}

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Types into the page field and submits it, as the reader does with Enter.
function typeAndSubmit(text: string): void {
  const field = host.querySelector('input');
  if (field === null) throw new Error('no page field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function pageField(): string {
  return host.querySelector('input')?.value ?? '';
}

beforeEach(() => {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('page labels in the reader', () => {
  it('shows the first page label and jumps by a typed label, then by a number', async () => {
    const jumps: number[] = [];
    act(() => {
      root.render(<Reader rpc={fakeRpc(3, ['i', 'ii', '1'])} total={3} jumps={jumps} />);
    });
    await flush();
    expect(pageField()).toBe('i');
    expect(host.querySelector('.doc-status-page')?.textContent).toBe(
      t('view.pageNumber', { page: 'i', total: 3 }),
    );

    typeAndSubmit('ii');
    expect(jumps).toEqual([1]);
    // '1' is the label of page 3, so the label wins over the page number 1.
    typeAndSubmit('1');
    expect(jumps).toEqual([1, 2]);
    typeAndSubmit('3');
    expect(jumps).toEqual([1, 2, 2]);
  });

  it('shows the page number and jumps by number when the document has no labels', async () => {
    const jumps: number[] = [];
    act(() => {
      root.render(<Reader rpc={fakeRpc(3, [])} total={3} jumps={jumps} />);
    });
    await flush();
    expect(pageField()).toBe('1');

    typeAndSubmit('2');
    expect(jumps).toEqual([1]);
  });
});
