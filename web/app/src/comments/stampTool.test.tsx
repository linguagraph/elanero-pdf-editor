// The stamp menu and the stamp tool's placement (W7.3 S6): the menu's keyboard, the args a
// chosen stamp sends, and Enter placing a stamp at the page centre.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { CommentLayer } from './CommentLayer';
import { placeComment } from './placement';
import { STANDARD_STAMPS } from './stamps';
import { StampMenu } from './stampTool';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a popover opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the stamp menu', () => {
  it('lists the 14 standard stamps and reports the one chosen', async () => {
    const onChoose = vi.fn();
    act(() => root.render(<StampMenu onChoose={onChoose} />));
    const button = container.querySelector<HTMLButtonElement>('button');
    act(() => {
      button?.focus();
      button?.click();
    });
    const items = document.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBe(STANDARD_STAMPS.length);
    expect(items.length).toBe(14);
    // Enter on the menu's first item chooses it; the arrow key moves the focus to the next one.
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    act(() => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const focused = document.activeElement;
    expect(focused?.getAttribute('role')).toBe('menuitem');
    act(() => {
      focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(STANDARD_STAMPS).toContain(onChoose.mock.calls[0]?.[0]);
  });
});

describe('the stamp tool on a page', () => {
  const layer = () => container.querySelector<HTMLDivElement>('.comment-layer');
  const px = CSS_PX_PER_POINT;

  it('a click places the stamp at the click point, as a zero-size rect', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 300 * px, clientY: 200 * px }),
      );
    });
    const [rect, text, points] = onPlace.mock.calls[0] ?? [];
    // The pointer offset is in CSS pixels, so the page point can be a float's rounding away.
    expect(rect.x0).toBeCloseTo(300);
    expect(rect.y0).toBeCloseTo(200);
    expect(rect.x1).toBe(rect.x0);
    expect(rect.y1).toBe(rect.y0);
    expect(text).toBe('');
    expect(points).toEqual([]);
  });

  it('Enter places the stamp at the centre of the page', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPlace).toHaveBeenCalledWith({ x0: 306, y0: 396, x1: 306, y1: 396 }, '', []);
  });
});

describe('placing a stamp', () => {
  it('sends the chosen stamp name with the stamp tool', async () => {
    const call = vi.fn(async () => ({
      label: 'Add Stamp',
      executed: false,
      value: null,
      changed: { changes: [], revisions: {} },
      state: { history: 1 },
    }));
    const deps = {
      rpc: { call } as never,
      handle: 'h1',
      scheduler: { noteRevisions: vi.fn() },
    };
    const rect = { x0: 72, y0: 72, x1: 72, y1: 72 };
    await placeComment(deps, 'stamp', 0, rect, '', [], 'Draft');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'stamp', page: 0, rect, text: '', points: [], stamp: 'Draft', author: '' },
    });
  });
});

describe('the stamp placement report and args', () => {
  const rect = { x0: 72, y0: 72, x1: 72, y1: 72 };
  const reply = {
    label: 'Add Annotation',
    executed: true,
    value: null,
    changed: { changes: [], revisions: {} },
    state: { history: 1 },
  };

  it('toasts the placed stamp with its label and the 1-based page', async () => {
    const call = vi.fn(async () => reply);
    const push = vi.fn(() => 1);
    const deps = {
      rpc: { call } as never,
      handle: 'h1',
      scheduler: { noteRevisions: vi.fn() },
      store: { push } as never,
    };
    await placeComment(deps, 'stamp', 0, rect, '', [], 'Draft');
    expect(push).toHaveBeenCalledWith('info', 'Draft stamp added on page 1.', expect.anything());
  });

  it('sends no stamp key for a sticky note', async () => {
    const call = vi.fn<(method: string, params: unknown) => Promise<typeof reply>>(
      async () => reply,
    );
    const deps = {
      rpc: { call } as never,
      handle: 'h1',
      scheduler: { noteRevisions: vi.fn() },
      store: { push: vi.fn(() => 1) } as never,
    };
    await placeComment(deps, 'note', 0, rect, 'Check this', [], '');
    expect(call.mock.calls[0]?.[1]).toHaveProperty('args.tool', 'note');
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty('args.stamp');
  });
});

describe('the stamp key on other tools', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const layer = () => container.querySelector<HTMLDivElement>('.comment-layer');

  it('only the stamp tool makes the page focusable', () => {
    for (const tool of ['note', 'rectangle', 'polygon'] as const) {
      act(() =>
        root.render(
          <CommentLayer tool={tool} zoom={1} widthPt={612} heightPt={792} onPlace={vi.fn()} />,
        ),
      );
      expect(layer()?.hasAttribute('tabindex')).toBe(false);
    }
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={vi.fn()} />,
      ),
    );
    expect(layer()?.getAttribute('tabindex')).toBe('0');
  });

  it('Enter places nothing for a note or a rectangle', () => {
    for (const tool of ['note', 'rectangle'] as const) {
      const onPlace = vi.fn();
      act(() =>
        root.render(
          <CommentLayer tool={tool} zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
        ),
      );
      const el = layer();
      if (el === null) throw new Error('no layer');
      act(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onPlace).not.toHaveBeenCalled();
    }
  });

  it('a held Enter key places one stamp, not one per repeat', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }));
    });
    expect(onPlace).not.toHaveBeenCalled();
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPlace).toHaveBeenCalledTimes(1);
  });
});
