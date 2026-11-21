import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { LinkDto } from '../rpc/generated';
import { t } from '../i18n/t';
import { CSS_PX_PER_POINT } from './zoom';
import { DocumentView } from './DocumentView';
import type { ViewTool } from './viewTool';

// jsdom has no CSS.escape, and react-aria calls it when a modal opens (see layout.test.tsx).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Page 1 has two links: a goto to page 3 that gives a top, and a web link (not followed yet).
const PAGE_ONE_LINKS: LinkDto[] = [
  { rect: { x0: 72, y0: 100, x1: 150, y1: 114 }, kind: 'goto', page: 2, top: 50, uri: '' },
  {
    rect: { x0: 72, y0: 200, x1: 150, y1: 214 },
    kind: 'uri',
    page: null,
    top: null,
    uri: 'https://example.org/',
  },
];

// Session.pages answers at once and the first page has links; render.page never answers, which
// keeps the test to the view.
function fakeRpc(pageOneLinks: LinkDto[] = PAGE_ONE_LINKS): PageRpc {
  const rpc = {
    call: vi.fn((method: string, params?: { page?: number }) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792, rotation: 0 })),
          labels: [],
        });
      }
      if (method === 'session.links') {
        const links = params?.page === 0 ? pageOneLinks : [];
        return Promise.resolve({ revision: 0, links, truncated: false });
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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(
  tool: ViewTool = 'select',
  props: { onLinkGoTo?: (page: number, top: number | null) => void } = {},
): Promise<void> {
  act(() => {
    root.render(<DocumentView rpc={fakeRpc()} handle="h" tool={tool} {...props} />);
  });
  await flush();
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

function link(index: number): HTMLElement {
  const element = host.querySelector<HTMLElement>(
    `[data-page="0"] .page-link[data-link="${index}"]`,
  );
  if (element === null) throw new Error(`no link ${index}`);
  return element;
}

// A pointer event as React reads it: a MouseEvent with the pointer fields added.
function pointer(element: HTMLElement, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  act(() => {
    element.dispatchEvent(event);
  });
}

// A tap on a link: down and up at the same place.
function tap(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const x = rect.left + 2;
  const y = rect.top + 2;
  pointer(element, 'pointerdown', x, y);
  pointer(element, 'pointerup', x, y);
}

describe('DocumentView links (W5.3)', () => {
  it('draws a link layer over the page only under the Select and Hand tools', async () => {
    await mount('select');
    expect(host.querySelectorAll('.page-link')).toHaveLength(2);
    rerenderWith('hand');
    await flush();
    expect(host.querySelectorAll('.page-link')).toHaveLength(2);
    rerenderWith('edit');
    await flush();
    expect(host.querySelectorAll('.page-link')).toHaveLength(0);
    rerenderWith('cropBox');
    await flush();
    expect(host.querySelectorAll('.page-link')).toHaveLength(0);
  });

  it('a tap on a goto link asks the app to jump, with the target top', async () => {
    const onLinkGoTo = vi.fn();
    await mount('select', { onLinkGoTo });
    scroller();
    tap(link(0));
    expect(onLinkGoTo).toHaveBeenCalledWith(2, 50);
  });

  it('a tap under the Hand tool follows the link too', async () => {
    const onLinkGoTo = vi.fn();
    await mount('hand', { onLinkGoTo });
    scroller();
    tap(link(0));
    expect(onLinkGoTo).toHaveBeenCalledWith(2, 50);
  });

  it('a drag that starts on a link pans and follows nothing', async () => {
    const onLinkGoTo = vi.fn();
    await mount('hand', { onLinkGoTo });
    const element = scroller();
    const target = link(0);
    const rect = target.getBoundingClientRect();
    pointer(target, 'pointerdown', rect.left + 2, rect.top + 2);
    pointer(element, 'pointermove', rect.left - 40, rect.top - 60);
    pointer(element, 'pointerup', rect.left - 40, rect.top - 60);
    expect(onLinkGoTo).not.toHaveBeenCalled();
    expect(element.scrollTop).toBeGreaterThan(0);
  });

  it('a web link asks first: the dialog opens and nothing opens until Open', async () => {
    const onLinkGoTo = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await mount('select', { onLinkGoTo });
    scroller();
    tap(link(1));
    expect(onLinkGoTo).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('.overlay-dialog')?.textContent).toContain(
      'https://example.org/',
    );
    open.mockRestore();
  });

  it('a blocked link shows its notice with the scheme and opens nothing', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    act(() => {
      root.render(
        <DocumentView
          rpc={fakeRpc([{ ...PAGE_ONE_LINKS[1]!, uri: 'javascript:alert(1)' }])}
          handle="h"
          tool="select"
        />,
      );
    });
    await flush();
    scroller();
    tap(link(0));
    expect(document.querySelector('.overlay-dialog')).toBeNull();
    expect(host.querySelector('.doc-link-notice')?.textContent).toBe(
      t('links.notice.blocked', { scheme: 'javascript' }),
    );
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('without an app handler the view scrolls itself to the target top', async () => {
    await mount('select');
    const element = scroller();
    tap(link(0));
    const withTop = element.scrollTop;

    // The same link without a top lands at the page's own top: the difference is the 50 pt target.
    act(() => root.unmount());
    root = createRoot(host);
    const noTop = PAGE_ONE_LINKS.map((item) => ({ ...item, top: null }));
    act(() => {
      root.render(<DocumentView rpc={fakeRpc(noTop)} handle="h" tool="select" />);
    });
    await flush();
    const plain = scroller();
    tap(link(0));
    // Within a few pixels: the view re-anchors its place after a scroll, which moves the result a little.
    expect(Math.abs(withTop - plain.scrollTop - 50 * CSS_PX_PER_POINT)).toBeLessThan(5);
  });

  function rerenderWith(tool: ViewTool): void {
    act(() => {
      root.render(<DocumentView rpc={fakeRpc()} handle="h" tool={tool} />);
    });
  }
});
