import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { Methods } from '../rpc/generated';
import { RenderScheduler } from '../view/renderScheduler';
import { ThumbnailsPanel } from './ThumbnailsPanel';
import { RailButton } from '../layout/RailButton';
import { RAIL_ICONS } from '../layout/railIcons';
import { closePanel, useOpenPanel } from '../layout/sidePanels';
import { t } from '../i18n/t';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // The side-panel store is module state: every test starts with both sides closed.
  closePanel('left');
  closePanel('right');
});

// A fake engine: session.pages answers at once, and each render.page answers at once with a blank
// page, so the thumbnails settle without the test driving each reply.
function fakeRpc(pageCount: number) {
  const calls: { method: string; params: unknown }[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'session.pages') {
        const pages = Array.from({ length: pageCount }, () => ({
          width: 612,
          height: 792,
          rotation: 0,
        }));
        return Promise.resolve({ pages });
      }
      const request = params as Methods['render.page']['params'];
      return Promise.resolve({
        width: 1,
        height: 1,
        revision: request.revision,
        format: 'rgba' as const,
        pixels: new ArrayBuffer(4),
      });
    }),
  };
  return { rpc: rpc as unknown as PageRpc, calls };
}

const context = {
  createImageData: vi.fn((width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  })),
  putImageData: vi.fn(),
};

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

// The side panel as the app composes it: a rail button and, when the tab's panel is open, the panel.
function Harness({
  tabId,
  rpc,
  onSelect,
}: {
  tabId: number;
  rpc: PageRpc;
  onSelect: (i: number) => void;
}) {
  const open = useOpenPanel('left') === 'pages';
  const scheduler = new RenderScheduler(rpc, 'h');
  let panel: ReactNode = null;
  if (open) {
    panel = (
      <ThumbnailsPanel
        rpc={rpc}
        handle="h"
        scheduler={scheduler}
        onSelect={onSelect}
        onClose={() => closePanel('left')}
      />
    );
  }
  return (
    <div data-tab={tabId}>
      <RailButton panel="pages" label={t('thumbnails.title')} icon={RAIL_ICONS.pages} />
      {panel}
    </div>
  );
}

function button(label: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`no button named ${label}`);
  return found;
}

function railButton(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('button[data-panel="pages"]');
  if (found === null) throw new Error('no rail button');
  return found;
}

describe('thumbnails side panel', () => {
  it('opens and closes from the rail button', async () => {
    const { rpc } = fakeRpc(3);
    act(() => root.render(<Harness tabId={101} rpc={rpc} onSelect={() => {}} />));
    expect(railButton().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.thumbs-scroll')).toBeNull();

    act(() => railButton().click());
    await flush();
    expect(railButton().getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.thumbs-scroll')).not.toBeNull();

    act(() => button('Close Thumbnails').click());
    expect(railButton().getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.thumbs-scroll')).toBeNull();
  });

  it('keeps the open panel when the document changes', async () => {
    const { rpc } = fakeRpc(2);
    act(() => root.render(<Harness tabId={201} rpc={rpc} onSelect={() => {}} />));
    act(() => railButton().click());
    await flush();

    act(() => root.render(<Harness tabId={202} rpc={rpc} onSelect={() => {}} />));
    expect(railButton().getAttribute('aria-expanded')).toBe('true');

    act(() => root.render(<Harness tabId={201} rpc={rpc} onSelect={() => {}} />));
    expect(railButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('calls the scroll function with the page index when a thumbnail is chosen', async () => {
    const { rpc } = fakeRpc(3);
    const onSelect = vi.fn();
    const scheduler = new RenderScheduler(rpc, 'h');
    act(() =>
      root.render(
        <ThumbnailsPanel
          rpc={rpc}
          handle="h"
          scheduler={scheduler}
          onSelect={onSelect}
          onClose={() => {}}
        />,
      ),
    );
    await flush();
    act(() => button('Go to page 2 of 3').click());
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders the thumbnails at the thumbnail scale, not the page scale', async () => {
    const { rpc, calls } = fakeRpc(2);
    const scheduler = new RenderScheduler(rpc, 'h');
    act(() =>
      root.render(
        <ThumbnailsPanel
          rpc={rpc}
          handle="h"
          scheduler={scheduler}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await flush();
    const renders = calls.filter((call) => call.method === 'render.page');
    expect(renders.length).toBeGreaterThan(0);
    for (const render of renders) {
      // 160 CSS px over a 612 pt page is about 0.26 device px per point, far below any page scale.
      const scale = (render.params as Methods['render.page']['params']).scale_milli;
      expect(scale).toBeGreaterThan(200);
      expect(scale).toBeLessThan(300);
    }
  });
});
