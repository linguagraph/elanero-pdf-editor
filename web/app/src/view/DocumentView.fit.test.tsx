import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY, readPreferences, writePreferences } from '../prefs/store';
import { DocumentView } from './DocumentView';
import { fitPageZoom, fitWidthZoom } from './layout';
import { scaleMilli, stepZoom } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page sizes the fake engine reports: one Letter page, 612 x 792 pt.
const LETTER = { width: 612, height: 792 };

// A fake engine: session.pages answers at once; render.page is recorded and never answered.
function fakeRpc() {
  const renders: { scale_milli: number }[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        return Promise.resolve({ pages: [{ ...LETTER, rotation: 0 }], labels: [] });
      }
      if (method === 'text.layer') return new Promise(() => undefined);
      if (method === 'render.page') renders.push(params as { scale_milli: number });
      return new Promise(() => undefined);
    }),
  };
  return { rpc: rpc as unknown as PageRpc, renders };
}

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The view's viewport is the window in jsdom (no layout), so the fit modes use the window's size.
const viewWidth = () => window.innerWidth;
const viewHeight = () => window.innerHeight;

const zoomText = () => host.querySelector('.doc-view-zoom')?.textContent;

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

function savePreferences(record: Record<string, unknown>): void {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(record));
}

beforeEach(() => {
  window.localStorage.clear();
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
});

describe('DocumentView fit modes (W5.1e)', () => {
  it('opens at the fit width scale when the saved default is Fit width', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc, renders } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const zoom = fitWidthZoom(LETTER.width, viewWidth());
    expect(zoomText()).toBe(`${Math.round(zoom * 100)}%`);
    expect(button('Fit width')?.getAttribute('aria-pressed')).toBe('true');
    await flush();
    expect(renders[0]?.scale_milli).toBe(scaleMilli(zoom, window.devicePixelRatio || 1));
  });

  it('opens at the fit page scale when the saved default is Fit page', async () => {
    savePreferences({ defaultZoom: 'fitPage' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const zoom = fitPageZoom(LETTER.width, LETTER.height, viewWidth(), viewHeight());
    expect(zoomText()).toBe(`${Math.round(zoom * 100)}%`);
    expect(button('Fit page')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens at actual size when the saved default is 100 %', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(zoomText()).toBe('100%');
  });

  it('applies a changed default while the document is open', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(zoomText()).toBe('100%');

    act(() => {
      writePreferences({ ...readPreferences(), defaultZoom: 'fitWidth' });
    });
    const zoom = fitWidthZoom(LETTER.width, viewWidth());
    expect(zoomText()).toBe(`${Math.round(zoom * 100)}%`);
  });

  it('keeps a manual zoom when a different preference is saved', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    act(() => {
      button('Zoom in')?.click();
    });
    expect(zoomText()).toBe('125%');
    act(() => {
      writePreferences({ ...readPreferences(), authorName: 'Reader' });
    });
    expect(zoomText()).toBe('125%');
  });

  it('leaves the fit mode on zoom in, and the step is taken from the fitted zoom', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const fitted = fitWidthZoom(LETTER.width, viewWidth());
    act(() => {
      button('Zoom in')?.click();
    });
    expect(zoomText()).toBe(`${Math.round(stepZoom(fitted, 1) * 100)}%`);
    expect(button('Fit width')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('leaves the fit mode on zoom out too', async () => {
    savePreferences({ defaultZoom: 'fitPage' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const fitted = fitPageZoom(LETTER.width, LETTER.height, viewWidth(), viewHeight());
    act(() => {
      button('Zoom out')?.click();
    });
    expect(zoomText()).toBe(`${Math.round(stepZoom(fitted, -1) * 100)}%`);
    expect(button('Fit page')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches between the fit modes and to actual size from the toolbar', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    act(() => {
      button('Fit width')?.click();
    });
    expect(zoomText()).toBe(`${Math.round(fitWidthZoom(LETTER.width, viewWidth()) * 100)}%`);
    act(() => {
      button('Fit page')?.click();
    });
    expect(zoomText()).toBe(
      `${Math.round(fitPageZoom(LETTER.width, LETTER.height, viewWidth(), viewHeight()) * 100)}%`,
    );
    act(() => {
      button('Actual size')?.click();
    });
    expect(zoomText()).toBe('100%');
  });

  it('refits the fit width mode when the window is resized', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const before = window.innerWidth;
    window.innerWidth = before / 2;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    window.innerWidth = before;
    expect(zoomText()).toBe(`${Math.round(fitWidthZoom(LETTER.width, before / 2) * 100)}%`);
  });

  it('presses Actual size only at 100 % with no fit mode', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(button('Actual size')?.getAttribute('aria-pressed')).toBe('false');
    act(() => {
      button('Actual size')?.click();
    });
    expect(button('Actual size')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('Fit width')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores a width change under 1 px, so the fitted zoom does not flip', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
    if (scroller === null) throw new Error('no scroll area');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 800 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const at800 = `${Math.round(fitWidthZoom(LETTER.width, 800) * 100)}%`;
    expect(zoomText()).toBe(at800);
    // A 0.5 px change is rounding: the zoom stays.
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 799.5 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(zoomText()).toBe(at800);
    // A 10 px change (a scrollbar) refits.
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 790 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(zoomText()).toBe(`${Math.round(fitWidthZoom(LETTER.width, 790) * 100)}%`);
  });

  it('leaves fit mode on Ctrl+wheel and steps from the fitted zoom', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const fitted = fitWidthZoom(LETTER.width, viewWidth());
    const scroll = host.querySelector<HTMLElement>('.doc-view-scroll');
    act(() => {
      scroll?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true, bubbles: true }),
      );
    });
    expect(zoomText()).toBe(`${Math.round(stepZoom(fitted, 1) * 100)}%`);
    expect(button('Fit width')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('fits the width of two pages side by side in the two-page layout', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    act(() => {
      button('Two pages')?.click();
    });
    expect(zoomText()).toBe(`${Math.round(fitWidthZoom(LETTER.width, viewWidth(), 2) * 100)}%`);
    // Two pages fill less zoom than one page would, since each page is half the width.
    expect(fitWidthZoom(LETTER.width, viewWidth(), 2)).toBeLessThan(
      fitWidthZoom(LETTER.width, viewWidth(), 1),
    );
  });
});
