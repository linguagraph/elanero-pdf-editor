import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY, readPreferences, writePreferences } from '../prefs/store';
import type { DocumentViewHandle } from './DocumentView';
import { fitPageZoom, fitWidthZoom } from './layout';
import { MAX_RENDER_SCALE_MILLI, quantizeScale, scaleMilli, stepZoom } from './zoom';
import { ViewWithStatus } from './viewWithStatus.testutil';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page sizes the fake engine reports: one Letter page, 612 x 792 pt.
const LETTER = { width: 612, height: 792 };

// A fake engine: session.pages answers at once; render.page is recorded and never answered.
// With rejectRenders, a render is recorded and then fails at once, so the scheduler's in-flight
// slots free up and the queue reaches the renders planned after a zoom change.
function fakeRpc({ rejectRenders = false }: { rejectRenders?: boolean } = {}) {
  const renders: { scale_milli: number }[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        return Promise.resolve({ pages: [{ ...LETTER, rotation: 0 }], labels: [] });
      }
      if (method === 'text.layer') return new Promise(() => undefined);
      // A page over 4 MP is planned as tiles, so both kinds of render carry the scale.
      if (method === 'render.page' || method === 'render.tile') {
        renders.push(params as { scale_milli: number });
        if (rejectRenders) return Promise.reject(new Error('render stub'));
      }
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

// The zoom box of the canvas pill shows the zoom as a percentage.
const zoomText = () => host.querySelector<HTMLInputElement>('.doc-status-zoom-input')?.value;

// A pill button, by its accessible name (the aria-label, else its text).
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
  );

// Picks the preset with the given label from the zoom box's list.
function choosePreset(label: string): void {
  act(() => {
    button('Zoom presets')?.click();
  });
  const preset = [...host.querySelectorAll<HTMLButtonElement>('.doc-status-presets button')].find(
    (b) => b.textContent === label,
  );
  act(() => {
    preset?.click();
  });
}

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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(zoomText()).toBe('100%');
  });

  it('applies a changed default while the document is open', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const fitted = fitPageZoom(LETTER.width, LETTER.height, viewWidth(), viewHeight());
    act(() => {
      button('Zoom out')?.click();
    });
    expect(zoomText()).toBe(`${Math.round(stepZoom(fitted, -1) * 100)}%`);
    expect(button('Fit page')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches between the fit modes and to actual size from the pill', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
    choosePreset('100%');
    expect(zoomText()).toBe('100%');
    expect(button('Fit width')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('refits the fit width mode when the window is resized', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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

  it('ignores a width change under 1 px, so the fitted zoom does not flip', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
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

  it('clamps the render scale when zoom 64 on a high pixel-ratio screen would exceed the engine limit', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc, renders } = fakeRpc({ rejectRenders: true });
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 4 });
    try {
      act(() => {
        root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
      });
      await flush();
      // Zoom in from 100 % to the maximum: 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64.
      for (let i = 0; i < 11; i += 1) {
        act(() => {
          button('Zoom in')?.click();
        });
      }
      await flush();
      await flush();
      expect(zoomText()).toBe('6400%');
      expect(renders.length).toBeGreaterThan(0);
      // The unclamped device scale is about 341 (64 x 96/72 x 4), over the 256 limit.
      expect(quantizeScale(64 * (4 / 3) * 4)).toBeGreaterThan(MAX_RENDER_SCALE_MILLI);
      // Every render asked for after the zoom is at the clamped scale, and none above it.
      const zoomed = renders.filter((r) => r.scale_milli === MAX_RENDER_SCALE_MILLI);
      expect(zoomed.length).toBeGreaterThan(0);
      expect(renders.every((r) => r.scale_milli <= MAX_RENDER_SCALE_MILLI)).toBe(true);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: original });
    }
  });

  it('leaves the render scale of a normal zoom unchanged', async () => {
    savePreferences({ defaultZoom: 'actual' });
    const { rpc, renders } = fakeRpc();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    await flush();
    expect(renders[0]?.scale_milli).toBe(scaleMilli(1, window.devicePixelRatio || 1));
    expect(renders[0]?.scale_milli).toBeLessThan(MAX_RENDER_SCALE_MILLI);
  });

  it('fits the width of two pages side by side in the two-page layout', async () => {
    savePreferences({ defaultZoom: 'fitWidth' });
    const { rpc } = fakeRpc();
    const viewRef = createRef<DocumentViewHandle>();
    act(() => {
      root.render(<ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" />);
    });
    await flush();
    act(() => {
      viewRef.current?.setLayout({ layout: 'twoPage', firstAlone: false });
    });
    expect(zoomText()).toBe(`${Math.round(fitWidthZoom(LETTER.width, viewWidth(), 2) * 100)}%`);
    // Two pages fill less zoom than one page would, since each page is half the width.
    expect(fitWidthZoom(LETTER.width, viewWidth(), 2)).toBeLessThan(
      fitWidthZoom(LETTER.width, viewWidth(), 1),
    );
  });
});
