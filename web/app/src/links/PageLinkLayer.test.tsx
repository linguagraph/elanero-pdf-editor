import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointsToCss } from '../comments/coordinates';
import type { LinkDto, LinksResult } from '../rpc/generated';
import { t } from '../i18n/t';
import { LinkCache, type LinksRpc } from './linkCache';
import { PageLinkLayer } from './PageLinkLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINKS: LinkDto[] = [
  // Listed out of reading order: the layer sorts them, so the lower link comes second.
  { rect: { x0: 200, y0: 300, x1: 260, y1: 312 }, kind: 'goto', page: 0, top: null, uri: '' },
  { rect: { x0: 72, y0: 100, x1: 150, y1: 114 }, kind: 'goto', page: 1, top: 40, uri: '' },
  { rect: { x0: 72, y0: 400, x1: 150, y1: 414 }, kind: 'goto', page: null, top: null, uri: '' },
  {
    rect: { x0: 72, y0: 420, x1: 150, y1: 434 },
    kind: 'uri',
    page: null,
    top: null,
    uri: 'https://example.org/',
  },
];

// A cache whose engine answers with LINKS at the revision the test chooses.
function cacheAt(revision: number, links: LinkDto[] = LINKS): LinkCache {
  const result: LinksResult = { revision, links, truncated: false };
  const rpc: LinksRpc = {
    call: vi.fn(() => Promise.resolve(result)) as unknown as LinksRpc['call'],
  };
  return new LinkCache(rpc, 'h');
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

async function render(
  cache: LinkCache,
  options: { zoom?: number; revision?: number; labels?: string[]; onFollow?: () => void } = {},
): Promise<void> {
  act(() => {
    root.render(
      <PageLinkLayer
        cache={cache}
        page={0}
        revision={options.revision ?? 1}
        zoom={options.zoom ?? 1}
        labels={options.labels ?? []}
        onFollow={options.onFollow ?? (() => {})}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function spans(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="link"]'));
}

describe('PageLinkLayer', () => {
  it('places each link from its rect in points, scaled by the zoom', async () => {
    for (const zoom of [1, 1.5, 2]) {
      await render(cacheAt(1), { zoom });
      const first = spans()[0];
      const rect = LINKS[1]?.rect;
      if (first === undefined || rect === undefined) throw new Error('no link');
      expect(parseFloat(first.style.left)).toBeCloseTo(pointsToCss(rect.x0, zoom), 2);
      expect(parseFloat(first.style.top)).toBeCloseTo(pointsToCss(rect.y0, zoom), 2);
      expect(parseFloat(first.style.width)).toBeCloseTo(pointsToCss(rect.x1 - rect.x0, zoom), 2);
      expect(parseFloat(first.style.height)).toBeCloseTo(pointsToCss(rect.y1 - rect.y0, zoom), 2);
    }
  });

  it('lists the links in reading order', async () => {
    await render(cacheAt(1));
    expect(spans().map((span) => span.dataset.link)).toEqual(['0', '1', '2', '3']);
    expect(spans().map((span) => span.style.top)).toEqual(
      ['100', '300', '400', '420'].map((points) => `${pointsToCss(Number(points), 1)}px`),
    );
  });

  it('names each link by where it goes, with the page label when the document has one', async () => {
    await render(cacheAt(1), { labels: ['i', 'iv'] });
    const names = spans().map((span) => span.getAttribute('aria-label'));
    // In reading order: the goto to page 2 (label iv), the goto to page 1 (label i), the goto with
    // no page, then the web link, which names its host.
    expect(names).toEqual([
      t('links.goTo', { label: 'iv' }),
      t('links.goTo', { label: 'i' }),
      t('links.noTarget'),
      t('links.web', { address: 'example.org' }),
    ]);
  });

  it('gives a page title on hover for a goto link only', async () => {
    await render(cacheAt(1), { labels: ['i', 'iv'] });
    expect(spans()[0]?.title).toBe(t('links.title.page', { label: 'iv' }));
    // A web link's title is its address; a link with no target has none.
    expect(spans()[3]?.title).toBe('https://example.org/');
    expect(spans()[2]?.title).toBe('');
  });

  it('follows the link on Enter and not on Space', async () => {
    const onFollow = vi.fn();
    await render(cacheAt(1), { onFollow });
    const first = spans()[0];
    if (first === undefined) throw new Error('no link');
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onFollow).not.toHaveBeenCalled();
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onFollow).toHaveBeenCalledWith(LINKS[1]);
  });

  it('renders no anchor with an href', async () => {
    await render(cacheAt(1));
    expect(host.querySelector('a[href]')).toBeNull();
  });

  it('shows nothing for a reply at another revision than the page is at', async () => {
    await render(cacheAt(7), { revision: 1 });
    expect(spans()).toHaveLength(0);
  });

  it('drops the rectangles of the old revision while the new revision is pending', async () => {
    const oneLink = LINKS[1];
    if (oneLink === undefined) throw new Error('no link');
    let answerRevisionTwo: (result: LinksResult) => void = () => {};
    const rpc = {
      call: vi
        .fn()
        .mockResolvedValueOnce({ revision: 1, links: [oneLink], truncated: false })
        .mockReturnValueOnce(
          new Promise<LinksResult>((resolve) => {
            answerRevisionTwo = resolve;
          }),
        ),
    } as unknown as LinksRpc;
    const cache = new LinkCache(rpc, 'h');

    await render(cache, { revision: 1 });
    expect(spans()).toHaveLength(1);

    // The revision-2 reply is still pending: the revision-1 rectangle must not stay focusable.
    await render(cache, { revision: 2 });
    expect(spans()).toHaveLength(0);

    await act(async () => {
      answerRevisionTwo({ revision: 2, links: [oneLink], truncated: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(spans()).toHaveLength(1);
  });
});
