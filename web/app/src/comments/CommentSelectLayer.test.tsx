import { act, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type {
  CommentDto,
  CommentPageResult,
  PageCommentDto,
  PageThreadDto,
} from '../rpc/generated';
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
  let onOpenNote: ReturnType<typeof vi.fn<(next: SetStateAction<CommentRef | null>) => void>>;
  // The engine's answers to annotations.transform, and the toasts a move or resize shows.
  let runCall: ReturnType<typeof vi.fn>;
  let toastStore: ToastStore;

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
    onOpenNote = vi.fn();
    runCall = vi.fn(async () => ({
      executed: true,
      changed: { revisions: { '0': 2 } },
      state: { history: 1 },
    }));
    toastStore = createToastStore();
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
    reply: CommentPageResult = PAGE,
  ) {
    const call = vi.fn(() => Promise.resolve(reply));
    const cache = new CommentPageCache({ call } as unknown as CommentsRpc, 'h');
    const transformDeps = {
      rpc: { call: runCall } as unknown as PageRpc,
      handle: 'h',
      scheduler: { noteRevisions: vi.fn() },
      store: toastStore,
    };
    const element = (next: readonly CommentRef[]) => (
      <CommentSelectLayer
        cache={cache}
        page={0}
        revision={1}
        zoom={1}
        selection={next}
        onSelect={onSelect}
        transformDeps={transformDeps}
        openNote={null}
        onOpenNote={onOpenNote}
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

  // A pointer move or release on the window, at a page point (the layer's box is the page at 0, 0).
  function pointerOnWindow(type: 'pointermove' | 'pointerup', x: number, y: number): void {
    window.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: x * CSS_PX_PER_POINT,
        clientY: y * CSS_PX_PER_POINT,
      }),
    );
  }

  // The arguments of the one annotations.transform the layer sent.
  interface TransformWire {
    refs: unknown;
    matrix: { a: number; b: number; c: number; d: number; e: number; f: number };
    resize: boolean;
  }
  function transformArgs(): TransformWire {
    const [, request] = runCall.mock.calls[0] as [string, { args: TransformWire }];
    return request.args;
  }

  // The matrix's numbers, each within float error of the expected one: a pointer position converted
  // to page points is not exact in binary.
  function expectMatrix(
    m: TransformWire['matrix'],
    [a, b, c, d, e, f]: readonly [number, number, number, number, number, number],
  ): void {
    expect(m.a).toBeCloseTo(a, 9);
    expect(m.b).toBeCloseTo(b, 9);
    expect(m.c).toBeCloseTo(c, 9);
    expect(m.d).toBeCloseTo(d, 9);
    expect(m.e).toBeCloseTo(e, 9);
    expect(m.f).toBeCloseTo(f, 9);
  }

  // A page whose only comment is `a`, with the given flags.
  function pageWith(flags: Partial<PageCommentDto>): CommentPageResult {
    return { revision: 1, threads: [thread({ ...comment('a', 10, 10), ...flags })] };
  }

  it('a press on a selected comment and a drag moves it with one annotations.transform', async () => {
    await render([{ page: 0, name: 'a' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointermove', 20, 30);
    });
    await act(async () => {
      pointerOnWindow('pointerup', 25, 35);
    });
    expect(runCall).toHaveBeenCalledTimes(1);
    const args = transformArgs();
    expect(args.refs).toEqual([{ page: 0, name: 'a' }]);
    expect(args.resize).toBe(false);
    expectMatrix(args.matrix, [1, 0, 0, 1, 10, 20]);
  });

  it('a drag shows the outline where the comment is going, before the release', async () => {
    const { layer } = await render([{ page: 0, name: 'a' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointermove', 25, 35);
    });
    const outline = layer.querySelector<HTMLDivElement>('.comment-select-outline');
    // The outline's left edge moved 10 points (x0 10 to 20), at zoom 1.
    expect(parseFloat(outline?.style.left ?? '')).toBeCloseTo(20 * CSS_PX_PER_POINT, 6);
    expect(runCall).not.toHaveBeenCalled();
    await act(async () => {
      pointerOnWindow('pointerup', 25, 35);
    });
  });

  it('a press and release without a move is a click: a multi-selection collapses', async () => {
    await render([
      { page: 0, name: 'a' },
      { page: 0, name: 'b' },
    ]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 15, 15);
    });
    expect(onSelect).toHaveBeenLastCalledWith([{ page: 0, name: 'a' }]);
    expect(runCall).not.toHaveBeenCalled();
  });

  it('a press on a selected locked comment moves nothing', async () => {
    await render([{ page: 0, name: 'a' }], {}, pageWith({ movable: false, resizable: false }));
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointermove', 40, 40);
    });
    await act(async () => {
      pointerOnWindow('pointerup', 40, 40);
    });
    expect(runCall).not.toHaveBeenCalled();
  });

  it('a press on a selected locked comment says why, and writes nothing', async () => {
    await render([{ page: 0, name: 'a' }], {}, pageWith({ movable: false, resizable: false }));
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 15, 15);
    });
    expect(toastStore.getState().visible[0]?.text).toBe(t('comments.locked'));
    expect(runCall).not.toHaveBeenCalled();
  });

  it('draws eight handles on the one selected comment that can be resized', async () => {
    const { layer } = await render([{ page: 0, name: 'a' }], {}, pageWith({ resizable: true }));
    expect(layer.querySelectorAll('.comment-select-handle')).toHaveLength(8);
  });

  it('dragging the bottom-right handle resizes the comment with resize true', async () => {
    await render([{ page: 0, name: 'a' }], {}, pageWith({ resizable: true }));
    await act(async () => {
      pageEl().dispatchEvent(pressAt(30, 30));
    });
    await act(async () => {
      pointerOnWindow('pointermove', 40, 50);
    });
    await act(async () => {
      pointerOnWindow('pointerup', 40, 50);
    });
    const args = transformArgs();
    expect(args.refs).toEqual([{ page: 0, name: 'a' }]);
    expect(args.resize).toBe(true);
    expectMatrix(args.matrix, [1.5, 0, 0, 2, -5, -10]);
  });

  it('a press 2 pt off a handle and released in place resizes nothing', async () => {
    await render([{ page: 0, name: 'a' }], {}, pageWith({ resizable: true }));
    // The bottom-right handle of the 20-point note is at (30, 30); the press is 2 points off it.
    await act(async () => {
      pageEl().dispatchEvent(pressAt(32, 32));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 32, 32);
    });
    expect(runCall).not.toHaveBeenCalled();
  });

  it('a page change under a drag drops it: the release sends nothing', async () => {
    await render([{ page: 0, name: 'a' }]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointermove', 25, 35);
    });
    // The page moved on (a new revision): the drag is dropped before the release.
    await act(async () => {
      root.render(
        <CommentSelectLayer
          cache={
            new CommentPageCache(
              { call: vi.fn(() => Promise.resolve(PAGE)) } as unknown as CommentsRpc,
              'h',
            )
          }
          page={0}
          revision={2}
          zoom={1}
          selection={[{ page: 0, name: 'a' }]}
          onSelect={onSelect}
          transformDeps={{
            rpc: { call: runCall } as unknown as PageRpc,
            handle: 'h',
            scheduler: { noteRevisions: vi.fn() },
            store: toastStore,
          }}
          openNote={null}
          onOpenNote={onOpenNote}
        />,
      );
    });
    await act(async () => {
      pointerOnWindow('pointerup', 25, 35);
    });
    expect(runCall).not.toHaveBeenCalled();
  });

  it('a stale comment clears the selection, says so, and the page is read again', async () => {
    runCall.mockRejectedValueOnce(new RpcError('STALE_OBJECT', 'gone'));
    const { cache, call } = await render([{ page: 0, name: 'a' }]);
    const readsBefore = call.mock.calls.length;
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointermove', 25, 35);
    });
    await act(async () => {
      pointerOnWindow('pointerup', 25, 35);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenLastCalledWith([]);
    expect(toastStore.getState().visible[0]?.text).toBe(t('comments.stale'));
    // The next ask for the page is a new read, not the list the stale comment came from.
    await cache.get(0, 1);
    expect(call.mock.calls.length).toBe(readsBefore + 1);
  });

  it('a press on a note and release without a move opens its popup, and selects the note', async () => {
    await render([]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 15, 15);
    });
    expect(onSelect).toHaveBeenLastCalledWith([{ page: 0, name: 'a' }]);
    expect(onOpenNote).toHaveBeenCalledWith({ page: 0, name: 'a' });
    expect(runCall).not.toHaveBeenCalled();
  });

  it('a note dragged on release moves and does not open its popup', async () => {
    await render([]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 25, 35);
    });
    expect(runCall).toHaveBeenCalledTimes(1);
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it('a locked note opens its popup on a click, and a drag over it sends nothing', async () => {
    await render([], {}, pageWith({ movable: false, resizable: false, locked: true }));
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 15, 15);
    });
    expect(onOpenNote).toHaveBeenCalledWith({ page: 0, name: 'a' });
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 40, 40);
    });
    expect(runCall).not.toHaveBeenCalled();
  });

  it('a Ctrl-press on a note selects it without opening its popup', async () => {
    await render([]);
    await act(async () => {
      pageEl().dispatchEvent(pressAt(15, 15, { ctrlKey: true }));
    });
    await act(async () => {
      pointerOnWindow('pointerup', 15, 15);
    });
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it('draws the popup of the open note with its text and replies, and none on another page', async () => {
    const reply: CommentDto = {
      page: 0,
      name: 'r',
      type: 'Text',
      author: '',
      contents: 'Done',
      subject: '',
      created: null,
      modified: null,
      state: 'None',
      locked: false,
      rect: { x0: 10, y0: 10, x1: 30, y1: 30 },
    };
    const withReply: CommentPageResult = {
      revision: 1,
      threads: [
        {
          comment: { ...comment('a', 10, 10), contents: 'Check this', author: 'Ada' },
          replies: [reply],
        },
      ],
    };
    await render([], { openNote: { page: 0, name: 'a' } }, withReply);
    const popup = container.querySelector<HTMLElement>('.comment-note-popup');
    expect(popup).not.toBeNull();
    expect(popup?.querySelector('textarea')?.value).toBe('Check this');
    expect(popup?.textContent).toContain('Done');
    await render([], { openNote: { page: 1, name: 'a' } }, withReply);
    expect(container.querySelector('.comment-note-popup')).toBeNull();
  });

  it('forgets the open note when the page no longer holds it', async () => {
    await render([], { openNote: { page: 0, name: 'a' } }, PAGE);
    expect(onOpenNote).not.toHaveBeenCalled();
    const gone: CommentPageResult = { revision: 1, threads: [thread(comment('b', 100, 300))] };
    await render([], { openNote: { page: 0, name: 'a' } }, gone);
    expect(onOpenNote).toHaveBeenCalledTimes(1);
    const update = onOpenNote.mock.calls[0]?.[0];
    expect(typeof update === 'function' && update({ page: 0, name: 'a' })).toBeNull();
  });
  it('an arrow on a focused comment moves it by 1 pt, selects it, and holds one merge key', async () => {
    await render([]);
    const item = container.querySelector<HTMLButtonElement>('button.comment-list-item');
    await act(async () => {
      item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSelect).toHaveBeenCalledWith([{ page: 0, name: 'a' }]);
    expect(runCall).toHaveBeenCalledTimes(1);
    const [, request] = runCall.mock.calls[0] as [
      string,
      { args: TransformWire & { merge_key: string } },
    ];
    expect(request.args.merge_key).toBe('nudge:0:a:1');
    expect(request.args.resize).toBe(false);
    expectMatrix(request.args.matrix, [1, 0, 0, 1, 1, 0]);
  });

  // Dispatches an arrow key (Right) on a comment's list item: a keydown presses it, a keyup releases it.
  async function arrow(item: HTMLElement | null | undefined, type: 'keydown' | 'keyup') {
    await act(async () => {
      item?.dispatchEvent(new KeyboardEvent(type, { key: 'ArrowRight', bubbles: true }));
    });
  }

  it('two arrow presses with a keyup between them are two undo steps (two merge keys)', async () => {
    await render([]);
    const item = container.querySelector<HTMLButtonElement>('button.comment-list-item');
    await arrow(item, 'keydown');
    await arrow(item, 'keyup');
    await arrow(item, 'keydown');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(runCall).toHaveBeenCalledTimes(2);
    const keys = runCall.mock.calls.map(
      ([, request]) => (request as { args: { merge_key: string } }).args.merge_key,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('an arrow press on a locked comment sends nothing and says why', async () => {
    await render([], {}, pageWith({ movable: false, resizable: false, locked: true }));
    const item = container.querySelector<HTMLButtonElement>('button.comment-list-item');
    await arrow(item, 'keydown');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(runCall).not.toHaveBeenCalled();
    expect(toastStore.getState().visible[0]?.text).toBe(t('comments.locked'));
  });

  it('an arrow press on a comment that went stale clears the selection and says so', async () => {
    runCall.mockRejectedValueOnce(new RpcError('STALE_OBJECT', 'gone'));
    await render([{ page: 0, name: 'a' }]);
    const item = container.querySelector<HTMLButtonElement>('button.comment-list-item');
    await arrow(item, 'keydown');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSelect).toHaveBeenLastCalledWith([]);
    expect(toastStore.getState().visible[0]?.text).toBe(t('comments.stale'));
  });
});
