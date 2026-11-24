import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageCommentDto } from '../rpc/generated';
import type { CommentRef } from './hitTest';
import { commentLabel, PageCommentList, type PageCommentListProps } from './PageCommentList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function comment(name: string, over: Partial<PageCommentDto> = {}): PageCommentDto {
  const bounds = { x0: 10, y0: 10, x1: 30, y1: 30 };
  return {
    page: 0,
    name,
    type: 'Text',
    author: 'Ana',
    contents: 'Check this',
    subject: '',
    created: null,
    modified: null,
    state: 'None',
    locked: false,
    rect: bounds,
    bounds,
    hidden: false,
    movable: true,
    resizable: true,
    ...over,
  };
}

function key(target: Element, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  });
}

describe('PageCommentList', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onNudge: ReturnType<typeof vi.fn<PageCommentListProps['onNudge']>>;
  let onActivate: ReturnType<typeof vi.fn<PageCommentListProps['onActivate']>>;
  let onNudgeEnd: ReturnType<typeof vi.fn<PageCommentListProps['onNudgeEnd']>>;
  // The page's layer, which takes the focus when the last comment is deleted.
  let layer: HTMLDivElement;
  let pageLayer: { current: HTMLDivElement };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onNudge = vi.fn();
    onNudgeEnd = vi.fn();
    onActivate = vi.fn();
    layer = document.createElement('div');
    layer.tabIndex = -1;
    document.body.appendChild(layer);
    pageLayer = { current: layer };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    layer.remove();
  });

  function render(comments: PageCommentDto[]) {
    act(() =>
      root.render(
        <PageCommentList
          page={1}
          comments={comments}
          zoom={1}
          onNudge={onNudge}
          onNudgeEnd={onNudgeEnd}
          onActivate={onActivate}
          pageLayer={pageLayer}
        />,
      ),
    );
    return [...container.querySelectorAll<HTMLButtonElement>('button.comment-list-item')];
  }

  it('groups the comments of a page and labels each with its type, author and text', () => {
    const buttons = render([comment('a'), comment('b', { author: '', contents: '' })]);
    expect(container.querySelector('[role=group]')?.getAttribute('aria-label')).toBe(
      'Comments on page 2',
    );
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Note by Ana: Check this');
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Note');
  });

  it('says locked in the label of a locked comment, and cuts long text to 80 characters', () => {
    expect(commentLabel(comment('a', { locked: true }))).toBe('Note by Ana: Check this, locked');
    expect(commentLabel(comment('a', { contents: 'x'.repeat(200) }))).toBe(
      `Note by Ana: ${'x'.repeat(80)}`,
    );
  });

  it('has one tab stop: the first comment, then the one focused', () => {
    const buttons = render([comment('a'), comment('b'), comment('c')]);
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    act(() => buttons[1]?.focus());
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('Ctrl+Down and Ctrl+Up step between comments, Home and End go to the ends', () => {
    const buttons = render([comment('a'), comment('b'), comment('c')]);
    const first = buttons[0];
    if (first === undefined) throw new Error('no button');
    act(() => first.focus());
    key(first, 'ArrowDown', { ctrlKey: true });
    expect(document.activeElement).toBe(buttons[1]);
    key(buttons[1] as Element, 'End');
    expect(document.activeElement).toBe(buttons[2]);
    key(buttons[2] as Element, 'ArrowUp', { ctrlKey: true });
    expect(document.activeElement).toBe(buttons[1]);
    key(buttons[1] as Element, 'Home');
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0] as Element, 'ArrowUp', { ctrlKey: true });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('an arrow moves the focused comment by 1 pt, Shift by 10 pt', () => {
    const buttons = render([comment('a')]);
    key(buttons[0] as Element, 'ArrowLeft');
    expect(onNudge).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'a' }), -1, 0, false);
    key(buttons[0] as Element, 'ArrowDown', { shiftKey: true });
    expect(onNudge).toHaveBeenLastCalledWith(expect.anything(), 0, 10, false);
  });

  it('Alt with an arrow resizes the comment instead of moving it', () => {
    const buttons = render([comment('a')]);
    key(buttons[0] as Element, 'ArrowRight', { altKey: true });
    expect(onNudge).toHaveBeenLastCalledWith(expect.anything(), 1, 0, true);
  });

  it('releasing an arrow key tells the page the press ended', () => {
    const buttons = render([comment('a')]);
    key(buttons[0] as Element, 'ArrowLeft');
    act(() => {
      buttons[0]?.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(onNudgeEnd).toHaveBeenCalledWith(expect.objectContaining({ name: 'a' }));
    expect(onNudgeEnd).toHaveBeenCalledTimes(1);
  });

  it('a deleted comment passes the focus to the next one', () => {
    const buttons = render([comment('a'), comment('b'), comment('c')]);
    act(() => buttons[1]?.focus());
    const after = render([comment('a'), comment('c')]);
    expect(document.activeElement).toBe(after[1]);
    expect(after[1]?.tabIndex).toBe(0);
  });

  it('a deleted last comment passes the focus to the previous one', () => {
    const buttons = render([comment('a'), comment('b'), comment('c')]);
    act(() => buttons[2]?.focus());
    const after = render([comment('a'), comment('b')]);
    expect(document.activeElement).toBe(after[1]);
  });

  it('deleting the only comment on the page focuses the page layer', () => {
    const buttons = render([comment('a')]);
    act(() => buttons[0]?.focus());
    render([]);
    expect(document.activeElement).toBe(layer);
  });

  it('a removal while the focus is elsewhere does not take the focus', () => {
    const buttons = render([comment('a'), comment('b')]);
    act(() => buttons[1]?.focus());
    const other = document.createElement('input');
    document.body.appendChild(other);
    act(() => other.focus());
    render([comment('a')]);
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it('a click on a comment (a focused button is clicked by Enter) activates it', () => {
    const buttons = render([comment('a', { type: 'Square' })]);
    act(() => buttons[0]?.click());
    expect(onActivate).toHaveBeenCalledWith(
      { page: 1, name: 'a' } satisfies CommentRef,
      expect.objectContaining({ name: 'a', type: 'Square' }),
    );
  });
});
