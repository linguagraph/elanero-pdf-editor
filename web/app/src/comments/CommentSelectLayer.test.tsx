import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentPageResult, PageCommentDto, PageThreadDto } from '../rpc/generated';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { CommentSelectLayer, type CommentSelectLayerProps } from './CommentSelectLayer';
import type { CommentRef } from './hitTest';
import { CommentPageCache, type CommentsRpc } from './pageCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A page of 612 x 792 points at zoom 1, with two notes: `a` at the top left, `b` lower down.
function comment(name: string, x0: number, y0: number, hidden = false): PageCommentDto {
  const bounds = { x0, y0, x1: x0 + 20, y1: y0 + 20 };
  return {
    page: 0,
    name,
    type: 'Text',
    author: '',
    contents: '',
    subject: '',
    created: null,
    modified: null,
    state: 'None',
    locked: false,
    rect: bounds,
    bounds,
    hidden,
    movable: true,
    resizable: false,
  };
}

function thread(comment_: PageCommentDto): PageThreadDto {
  return { comment: comment_, replies: [] };
}

const PAGE: CommentPageResult = {
  revision: 1,
  threads: [
    thread(comment('a', 10, 10)),
    thread(comment('b', 100, 300)),
    thread(comment('h', 200, 200, true)),
  ],
};

// A press at a page point (the page's top-left is the viewport origin, as jsdom lays nothing out).
function pressAt(x: number, y: number, extra: MouseEventInit = {}): MouseEvent {
  return new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: x * CSS_PX_PER_POINT,
    clientY: y * CSS_PX_PER_POINT,
    button: 0,
    ...extra,
  });
}

describe('CommentSelectLayer', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn<(next: readonly CommentRef[]) => void>>;

  // The page is the layer's parent: a press has to land on it (or inside it) to count.
  const pageEl = (): HTMLElement => {
    const layer = container.querySelector<HTMLDivElement>('.comment-select-layer');
    if (layer === null) throw new Error('no layer');
    return layer;
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // Renders the layer with a page list that has arrived, and pins the layer's box to the page.
  async function render(
    selection: readonly CommentRef[] = [],
    props: Partial<CommentSelectLayerProps> = {},
  ) {
    const call = vi.fn(() => Promise.resolve(PAGE));
    const cache = new CommentPageCache({ call } as unknown as CommentsRpc, 'h');
    const element = (next: readonly CommentRef[]) => (
      <CommentSelectLayer
        cache={cache}
        page={0}
        revision={1}
        zoom={1}
        selection={next}
        onSelect={onSelect}
        {...props}
      />
    );
    await act(async () => {
      root.render(element(selection));
    });
    const layer = container.querySelector<HTMLDivElement>('.comment-select-layer');
    if (layer === null) throw new Error('no layer');
    layer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 612 * CSS_PX_PER_POINT,
        bottom: 792 * CSS_PX_PER_POINT,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    // Re-renders keep the same cache, so the page list is already there.
    return { layer, element, cache, call };
  }

  it('outlines each selected comment and nothing else', async () => {
    await render([{ page: 0, name: 'b' }]);
    expect(container.querySelectorAll('.comment-select-outline')).toHaveLength(1);
  });

  it('a press on a comment selects only it', async () => {
    await render([{ page: 0, name: 'b' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    expect(onSelect).toHaveBeenLastCalledWith([{ page: 0, name: 'a' }]);
  });

  it('Ctrl-click toggles a comment within the selection', async () => {
    await render([{ page: 0, name: 'b' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15, { ctrlKey: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith([
      { page: 0, name: 'b' },
      { page: 0, name: 'a' },
    ]);
  });

  it('a press on empty page clears a selection, and a Ctrl-press on it keeps it', async () => {
    await render([{ page: 0, name: 'a' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(400, 600));
    });
    expect(onSelect).toHaveBeenLastCalledWith([]);
    onSelect.mockClear();
    await act(async () => {
      pageEl().dispatchEvent(pressAt(400, 600, { ctrlKey: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a press on a comment does not reach the page below (the text layer)', async () => {
    await render();
    const below = vi.fn();
    document.body.addEventListener('pointerdown', below);
    const press = pressAt(15, 15);
    await act(async () => {
      pageEl().dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    expect(below).not.toHaveBeenCalled();
    document.body.removeEventListener('pointerdown', below);
  });

  it('a press on a hidden comment selects nothing', async () => {
    await render();
    await act(async () => {
      pageEl().dispatchEvent(pressAt(205, 205));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a right-button press is not a selection', async () => {
    await render([{ page: 0, name: 'a' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15, { button: 2 }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a press on a button over the page does not change the selection or prevent the press', async () => {
    await render([{ page: 0, name: 'a' }]);
    const button = document.createElement('button');
    container.appendChild(button);
    const press = pressAt(15, 15);
    await act(async () => {
      button.dispatchEvent(press);
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(press.defaultPrevented).toBe(false);
    button.remove();
  });

  it('Escape inside a field leaves the selection and is not prevented', async () => {
    await render([{ page: 0, name: 'a' }]);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(key);
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
    input.remove();
  });

  it('asks for a reply that names another revision once more, and no more than that', async () => {
    const { call } = await render([], { revision: 2 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('Escape clears the selection', async () => {
    await render([{ page: 0, name: 'a' }]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith([]);
  });

  it('drops a selected comment that the page no longer holds', async () => {
    await render([
      { page: 0, name: 'gone' },
      { page: 1, name: 'elsewhere' },
    ]);
    expect(onSelect).toHaveBeenCalledWith([{ page: 1, name: 'elsewhere' }]);
  });
});
