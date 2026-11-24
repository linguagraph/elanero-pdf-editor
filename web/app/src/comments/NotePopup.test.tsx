import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { CommentDto, PageCommentDto } from '../rpc/generated';
import { NotePopup, type NotePopupProps } from './NotePopup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function note(overrides: Partial<PageCommentDto> = {}): PageCommentDto {
  const bounds = { x0: 10, y0: 10, x1: 30, y1: 30 };
  return {
    page: 0,
    name: 'a',
    type: 'Text',
    author: 'Ada',
    contents: 'First',
    subject: '',
    created: '2026-11-01T10:00:00',
    modified: null,
    state: 'None',
    locked: false,
    rect: bounds,
    bounds,
    hidden: false,
    movable: true,
    resizable: false,
    ...overrides,
  };
}

function reply(contents: string): CommentDto {
  return {
    page: 0,
    name: `r-${contents}`,
    type: 'Text',
    author: 'Bo',
    contents,
    subject: '',
    created: null,
    modified: null,
    state: 'None',
    locked: false,
    rect: { x0: 10, y0: 10, x1: 30, y1: 30 },
  };
}

describe('NotePopup', () => {
  let container: HTMLDivElement;
  let root: Root;
  let call: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let returnTo: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    returnTo = document.createElement('div');
    returnTo.tabIndex = -1;
    document.body.appendChild(returnTo);
    root = createRoot(container);
    call = vi.fn(async () => ({
      executed: true,
      changed: { revisions: {} },
      state: { history: 1 },
    }));
    onClose = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    returnTo.remove();
    vi.restoreAllMocks();
  });

  // Renders the popup; the props can be changed by rendering again with `next`.
  async function render(next: Partial<NotePopupProps> = {}, comment = note()) {
    const deps = {
      rpc: { call } as unknown as PageRpc,
      handle: 'h',
      scheduler: { noteRevisions: vi.fn() },
      store: createToastStore(),
    };
    const props: NotePopupProps = {
      comment,
      replies: [],
      deps,
      left: 40,
      top: 20,
      onClose,
      returnFocusTo: { current: returnTo },
      stillOnPage: () => true,
      ...next,
    };
    await act(async () => {
      root.render(<NotePopup {...props} />);
    });
    return props;
  }

  const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea');
  const replyInput = () =>
    container.querySelector<HTMLInputElement>('.comment-note-popup-reply input');

  function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('shows the author, the text and the replies, and shows document text as text', async () => {
    await render(
      { replies: [reply('Done'), reply('<img src=x>')] },
      note({ author: '', contents: '<b>Hi</b>' }),
    );
    expect(container.textContent).toContain(t('comments.popup.unknownAuthor'));
    expect(textarea()?.value).toBe('<b>Hi</b>');
    expect(container.textContent).toContain('<img src=x>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelectorAll('.comment-note-popup-replies li')).toHaveLength(2);
  });

  it('moves focus into the text when it opens', async () => {
    await render();
    expect(document.activeElement).toBe(textarea());
  });

  it('a locked note is read only', async () => {
    await render({}, note({ locked: true }));
    expect(textarea()?.readOnly).toBe(true);
  });

  it('Close saves changed text with annotations.set_text, once, and closes', async () => {
    await render();
    await act(async () => {
      type(textarea() as HTMLTextAreaElement, 'Second');
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.comment-note-popup-actions button')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // The owner unmounts the popup on close; the unmount is what saves.
    await act(async () => {
      root.render(<></>);
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'annotations.set_text',
      args: { ref: { page: 0, name: 'a' }, text: 'Second' },
    });
  });

  it('closing without a change sends nothing', async () => {
    await render();
    await act(async () => {
      root.render(<></>);
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('a locked note is never saved, even when its text was edited', async () => {
    await render({}, note({ locked: true }));
    await act(async () => {
      type(textarea() as HTMLTextAreaElement, 'Changed');
    });
    await act(async () => {
      root.render(<></>);
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('Escape in the text asks the owner to close the popup', async () => {
    await render();
    await act(async () => {
      textarea()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a press outside the popup closes it, and a press inside does not', async () => {
    await render();
    await act(async () => {
      textarea()?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a press on a menu or dialog over the page neither closes the popup nor saves it', async () => {
    await render();
    await act(async () => {
      type(textarea() as HTMLTextAreaElement, 'Second');
    });
    // A button appended over the page, as a menu's or a dialog's control is.
    const button = document.createElement('button');
    document.body.append(button);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    button.remove();
  });

  it('an outside change to the note, with no typing, is shown and never written back', async () => {
    await render();
    await render({}, note({ contents: 'Changed outside' }));
    expect(textarea()?.value).toBe('Changed outside');
    await act(async () => {
      root.render(<></>);
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('a note deleted while the popup had unsaved edits is not saved to', async () => {
    await render({ stillOnPage: () => false });
    await act(async () => {
      type(textarea() as HTMLTextAreaElement, 'Typed');
    });
    await act(async () => {
      root.render(<></>);
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('posting a reply on Enter calls annotations.reply and clears the box', async () => {
    await render();
    await act(async () => {
      type(replyInput() as HTMLInputElement, '  Agreed  ');
    });
    await act(async () => {
      replyInput()?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'annotations.reply',
      args: {
        parent: { page: 0, name: 'a' },
        text: 'Agreed',
        author: expect.any(String),
        state: 'None',
      },
    });
    // The post resolves after the engine answers; the box clears once it has.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(replyInput()?.value).toBe('');
  });

  it('a blank reply is not posted', async () => {
    await render();
    await act(async () => {
      type(replyInput() as HTMLInputElement, '   ');
    });
    await act(async () => {
      replyInput()?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('focus returns to the page when the popup closes with focus in it', async () => {
    await render();
    expect(document.activeElement).toBe(textarea());
    await act(async () => {
      root.render(<></>);
    });
    expect(document.activeElement).toBe(returnTo);
  });
});
