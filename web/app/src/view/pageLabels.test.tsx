import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { t } from '../i18n/t';
import { computeColumn, scrollTopForPage } from './layout';
import { ViewWithStatus } from './viewWithStatus.testutil';

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

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pillField(): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>('.doc-status-jump input');
  if (field === null) throw new Error('no page field in the pill');
  return field;
}

// Types into the pill's page field and submits it, as the reader does with Enter.
function typeAndSubmit(text: string): void {
  const field = pillField();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    field.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
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
  it('shows the first page label in the pill and jumps by a typed label, then by a number', async () => {
    act(() => {
      root.render(<ViewWithStatus rpc={fakeRpc(3, ['i', 'ii', '1'])} handle="doc-1" />);
    });
    await flush();
    expect(pillField().value).toBe('i');

    const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
    if (scroller === null) throw new Error('no scroll area');
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
    // At 100 % the pages are 792 pt tall, so the tops are the column's boxes.
    const boxes = computeColumn(
      Array.from({ length: 3 }, () => ({ width: 612, height: 792 })),
      1,
    ).boxes;
    const top = (index: number) => scrollTopForPage(boxes, index, 1);

    typeAndSubmit('ii');
    expect(scroller.scrollTop).toBeCloseTo(top(1) ?? -1);
    // '1' is the label of page 3, so the label wins over the page number 1.
    typeAndSubmit('1');
    expect(scroller.scrollTop).toBeCloseTo(top(2) ?? -1);
    typeAndSubmit('3');
    expect(scroller.scrollTop).toBeCloseTo(top(2) ?? -1);
  });

  it('shows the page number and refuses a page the document does not have', async () => {
    act(() => {
      root.render(<ViewWithStatus rpc={fakeRpc(3, [])} handle="doc-1" />);
    });
    await flush();
    expect(pillField().value).toBe('1');

    typeAndSubmit('9');
    expect(host.querySelector('.doc-status-error')?.textContent).toBe(
      t('view.jumpInvalid', { input: '9', total: 3 }),
    );
  });
});
