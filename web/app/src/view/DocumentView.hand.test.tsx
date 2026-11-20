import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { DocumentView } from './DocumentView';
import type { ViewTool } from './viewTool';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Session.pages answers at once; render.page never answers, which keeps the test to the view.
function fakeRpc(): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792, rotation: 0 })),
          labels: [],
        });
      }
      return new Promise(() => {});
    }),
  };
  return rpc as unknown as PageRpc;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(tool: ViewTool, onToolChange?: (next: ViewTool) => void): Promise<void> {
  act(() => {
    root.render(
      <DocumentView rpc={fakeRpc()} handle="h" tool={tool} onToolChange={onToolChange} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rerender(tool: ViewTool, onToolChange?: (next: ViewTool) => void): void {
  act(() => {
    root.render(
      <DocumentView rpc={fakeRpc()} handle="h" tool={tool} onToolChange={onToolChange} />,
    );
  });
}

// jsdom has no layout or pointer capture: plain properties let the test read what the view wrote.
function scroller(): HTMLElement {
  const element = host.querySelector<HTMLElement>('.doc-view-scroll');
  if (element === null) throw new Error('no scroll element');
  Object.defineProperties(element, {
    scrollTop: { value: 0, writable: true, configurable: true },
    scrollLeft: { value: 0, writable: true, configurable: true },
    scrollWidth: { value: 2000, configurable: true },
    scrollHeight: { value: 3000, configurable: true },
    clientWidth: { value: 800, configurable: true },
    clientHeight: { value: 600, configurable: true },
  });
  Object.assign(element, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: () => true,
  });
  return element;
}

interface PointerInit {
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly pointerType?: string;
}

// A pointer event as React reads it: a MouseEvent with the pointer fields added.
function pointer(element: HTMLElement, type: string, init: PointerInit): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    button: init.button ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: init.pointerType ?? 'mouse' },
  });
  act(() => {
    element.dispatchEvent(event);
  });
}

function drag(element: HTMLElement, init: Partial<PointerInit> = {}): void {
  const start = { x: 300, y: 300, ...init };
  pointer(element, 'pointerdown', start);
  pointer(element, 'pointermove', { ...start, x: start.x - 50, y: start.y - 100 });
  pointer(element, 'pointerup', { ...start, x: start.x - 50, y: start.y - 100 });
}

function commentButton(): HTMLButtonElement {
  const group = host.querySelector(`[role="group"][aria-label="${t('comment.toolbarLabel')}"]`);
  const button = group?.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('no comment tool button');
  return button;
}

describe('DocumentView with the Hand tool (W4.10)', () => {
  it('marks the view as Hand, and not otherwise', async () => {
    await mount('hand');
    expect(host.querySelector('.doc-view')?.classList.contains('doc-view--hand')).toBe(true);
    rerender('select');
    expect(host.querySelector('.doc-view')?.classList.contains('doc-view--hand')).toBe(false);
  });

  it('pans the scroll position by the inverse of a mouse drag', async () => {
    await mount('hand');
    const element = scroller();
    drag(element);
    expect(element.scrollLeft).toBe(50);
    expect(element.scrollTop).toBe(100);
  });

  it('pans with a pen', async () => {
    await mount('hand');
    const element = scroller();
    drag(element, { pointerType: 'pen' });
    expect(element.scrollTop).toBe(100);
  });

  it('leaves a one-finger touch to the browser', async () => {
    await mount('hand');
    const element = scroller();
    drag(element, { pointerType: 'touch' });
    expect(element.scrollLeft).toBe(0);
    expect(element.scrollTop).toBe(0);
  });

  it('pans only with the primary button', async () => {
    await mount('hand');
    const element = scroller();
    drag(element, { button: 1 });
    expect(element.scrollTop).toBe(0);
  });

  it('does nothing on a press on the scrollbar', async () => {
    await mount('hand');
    const element = scroller();
    // The scrollbar is outside the 800 x 600 client area.
    drag(element, { x: 820, y: 100 });
    expect(element.scrollLeft).toBe(0);
  });

  it('stops panning when the button is released', async () => {
    await mount('hand');
    const element = scroller();
    pointer(element, 'pointerdown', { x: 300, y: 300 });
    pointer(element, 'pointerup', { x: 300, y: 300 });
    pointer(element, 'pointermove', { x: 100, y: 100 });
    expect(element.scrollTop).toBe(0);
  });

  it('does not pan with the Select tool', async () => {
    await mount('select');
    const element = scroller();
    drag(element);
    expect(element.scrollLeft).toBe(0);
    expect(element.scrollTop).toBe(0);
  });

  it('hands the view to Select when a comment tool is chosen', async () => {
    const onToolChange = vi.fn();
    await mount('select', onToolChange);
    act(() => {
      commentButton().click();
    });
    expect(onToolChange).toHaveBeenCalledWith('select');
  });

  it('turns a comment tool off when the Hand tool is chosen', async () => {
    await mount('select');
    act(() => {
      commentButton().click();
    });
    expect(commentButton().getAttribute('aria-pressed')).toBe('true');
    rerender('hand');
    expect(commentButton().getAttribute('aria-pressed')).toBe('false');
  });
});
