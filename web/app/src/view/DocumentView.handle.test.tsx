import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView, type DocumentViewHandle } from './DocumentView';
import { computeColumn, fitWidthZoom, scrollTopForPage } from './layout';
import { stepZoom } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Session.pages answers at once; render.page never answers, which keeps the test to the layout.
function fakeRpc(pageCount: number): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: pageCount }, () => ({
            width: 612,
            height: 792,
            rotation: 0,
          })),
          labels: [],
        });
      }
      return new Promise(() => {});
    }),
  };
  return rpc as unknown as PageRpc;
}

const PAGES = Array.from({ length: 5 }, () => ({ width: 612, height: 792 }));

let host: HTMLDivElement;
let root: Root;
let handle: { current: DocumentViewHandle | null };

async function mount(defaultZoom: string): Promise<HTMLElement> {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom }));
  act(() => {
    root.render(
      <DocumentView
        rpc={fakeRpc(PAGES.length)}
        handle="h"
        ref={(value) => {
          handle.current = value;
        }}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
  if (scroller === null) throw new Error('no scroll element');
  // jsdom has no layout; a plain property lets the test read what the view wrote.
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
  return scroller;
}

// The width the view gave the first page, in CSS px.
function firstPageWidth(): number {
  const page = host.querySelector<HTMLElement>('.doc-page');
  if (page === null) throw new Error('no page drawn');
  return parseFloat(page.style.width);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  handle = { current: null };
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('DocumentView.zoom', () => {
  it('zooms to a percentage request', async () => {
    await mount('actual');
    act(() => handle.current?.zoom({ zoom: 2 }));
    const expected = computeColumn(PAGES, 2).boxes[0]?.width ?? -1;
    expect(firstPageWidth()).toBeCloseTo(expected);
  });

  it('takes one step of the zoom in each direction', async () => {
    await mount('actual');
    act(() => handle.current?.zoom({ step: 1 }));
    expect(firstPageWidth()).toBeCloseTo(
      computeColumn(PAGES, stepZoom(1, 1)).boxes[0]?.width ?? -1,
    );
    act(() => handle.current?.zoom({ step: -1 }));
    act(() => handle.current?.zoom({ step: -1 }));
    expect(firstPageWidth()).toBeCloseTo(
      computeColumn(PAGES, stepZoom(1, -1)).boxes[0]?.width ?? -1,
    );
  });

  it('fits the width when asked', async () => {
    await mount('actual');
    act(() => handle.current?.zoom({ fit: 'width' }));
    const fitted = fitWidthZoom(612, window.innerWidth, 1);
    expect(firstPageWidth()).toBeCloseTo(computeColumn(PAGES, fitted).boxes[0]?.width ?? -1);
  });
});

describe('DocumentView.focusPageField', () => {
  it('focuses the canvas pill page input and selects its text', async () => {
    await mount('actual');
    act(() => handle.current?.focusPageField());
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${t('view.goToPage')}"]`);
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input?.selectionEnd).toBe(input?.value.length);
  });
});

describe('DocumentView.stepPage', () => {
  it('moves to the next page and back, and stops at the first page', async () => {
    const scroller = await mount('actual');
    const boxes = computeColumn(PAGES, 1).boxes;
    act(() => handle.current?.stepPage(1));
    expect(scroller.scrollTop).toBeCloseTo(scrollTopForPage(boxes, 1, 1) ?? -1);
    act(() => handle.current?.stepPage(-1));
    expect(scroller.scrollTop).toBeCloseTo(0);
    act(() => handle.current?.stepPage(-1));
    expect(scroller.scrollTop).toBeCloseTo(0);
  });
});

describe('DocumentView.setCommentTool and setRedacting (W4.3a S7)', () => {
  // The toolbar's button with this label, found by its text (the toolbar groups are not named).
  function toolbarButton(label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.doc-view-toolbar button')].find(
      (el) => el.textContent?.trim() === label,
    );
    if (found === undefined) throw new Error(`no toolbar button ${label}`);
    return found;
  }

  async function mountReporting(
    onCommentToolChange: (tool: string | null) => void,
    onToolChange: (tool: string) => void,
  ): Promise<void> {
    act(() => {
      root.render(
        <DocumentView
          rpc={fakeRpc(PAGES.length)}
          handle="h"
          tool="hand"
          onToolChange={onToolChange}
          onCommentToolChange={onCommentToolChange}
          ref={(value) => {
            handle.current = value;
          }}
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('turns a comment tool on and off, shows it pressed, and turns the Hand tool off', async () => {
    const report = vi.fn();
    const toolChange = vi.fn();
    await mountReporting(report, toolChange);
    expect(report).toHaveBeenLastCalledWith(null);

    act(() => handle.current?.setCommentTool('note'));
    expect(toolbarButton(t('comment.tool.note')).getAttribute('aria-pressed')).toBe('true');
    expect(report).toHaveBeenLastCalledWith('note');
    expect(toolChange).toHaveBeenCalledWith('select');

    act(() => handle.current?.setCommentTool(null));
    expect(toolbarButton(t('comment.tool.note')).getAttribute('aria-pressed')).toBe('false');
    expect(report).toHaveBeenLastCalledWith(null);
  });

  it('turns the mark tool on, which turns the comment tool off', async () => {
    const report = vi.fn();
    const toolChange = vi.fn();
    await mountReporting(report, toolChange);
    act(() => handle.current?.setCommentTool('rectangle'));
    act(() => handle.current?.setRedacting(true));
    expect(toolbarButton(t('redact.mark')).getAttribute('aria-pressed')).toBe('true');
    expect(toolbarButton(t('comment.tool.rectangle')).getAttribute('aria-pressed')).toBe('false');
    expect(report).toHaveBeenLastCalledWith(null);

    act(() => handle.current?.setRedacting(false));
    expect(toolbarButton(t('redact.mark')).getAttribute('aria-pressed')).toBe('false');
  });
});
