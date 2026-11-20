import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { CommentsImportDialog, type CommentsImportDialogProps } from './CommentsImportDialog';
import { MAX_XFDF_BYTES } from './xfdfImport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape: (value: string) => value.replace(/[^\w-]/g, (char) => String.fromCharCode(92) + char),
    },
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function hasButton(text: string): boolean {
  return [...document.querySelectorAll('button')].some((button) => button.textContent === text);
}

// A fake engine: each method answers from the table, and every call is recorded.
function fakeEngine(answers: Record<string, (params: unknown) => unknown>) {
  const call = vi.fn(async (method: string, params: unknown) => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer(params);
  });
  return { call, rpc: { call, chunked: vi.fn() } as unknown as PageRpc };
}

const TWO_COMMENTS = {
  'comments.xfdf_preview': () => ({ comments: 2, replies: 1, pages: [0] }),
  'actions.run': () => ({
    label: 'Import 2 Comments',
    executed: true,
    value: 2,
    changed: { changes: [], revisions: { '0': 7 } },
    state: { history: 7 },
  }),
  'actions.undo': () => ({
    done: true,
    label: 'Import 2 Comments',
    changed: { changes: [], revisions: { '0': 8 } },
    state: { history: 6 },
  }),
};

function setup(answers: Record<string, (params: unknown) => unknown> = TWO_COMMENTS) {
  const { call, rpc } = fakeEngine(answers);
  const store: ToastStore = createToastStore();
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const props: CommentsImportDialogProps = {
    isOpen: true,
    onClose,
    engine: rpc,
    handle: 'h1',
    onChanged,
    store,
  };
  act(() => root.render(<CommentsImportDialog {...props} />));
  return { call, store, onClose, onChanged };
}

// Picks a file in the dialog's file input, as the browser does.
async function pick(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

function xfdfFile(text = '<xfdf/>'): File {
  return new File([text], 'review.xfdf', { type: 'application/vnd.adobe.xfdf' });
}

describe('CommentsImportDialog', () => {
  it('previews the counts and imports them as one action', async () => {
    const { call, store, onClose, onChanged } = setup();
    await pick(xfdfFile('<xfdf>x</xfdf>'));

    expect(call).toHaveBeenCalledWith('comments.xfdf_preview', {
      handle: 'h1',
      text: '<xfdf>x</xfdf>',
    });
    expect(document.body.textContent).toContain(
      t('commentsImport.preview', { count: 2, replies: 1, pages: 1 }),
    );

    await act(async () => {
      buttonNamed(t('commentsImport.import')).click();
    });
    await settle();

    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.import_xfdf',
      args: { text: '<xfdf>x</xfdf>' },
    });
    expect(onChanged).toHaveBeenCalledWith({ changes: [], revisions: { '0': 7 } });
    expect(onClose).toHaveBeenCalled();
    const done = store
      .getState()
      .visible.find((toast) => toast.text === t('commentsImport.done', { count: 2 }));
    expect(done?.action?.label).toBe(t('toast.undo'));

    // The Undo names the import's history, and redraws the pages it brings back.
    onChanged.mockClear();
    done?.action?.run();
    await settle();
    expect(call).toHaveBeenLastCalledWith('actions.undo', { handle: 'h1', expect_history: 7 });
    expect(onChanged).toHaveBeenCalledWith({ changes: [], revisions: { '0': 8 } });
  });

  it('refuses an oversize file without asking the engine', async () => {
    const { call } = setup();
    const big = xfdfFile();
    Object.defineProperty(big, 'size', { value: MAX_XFDF_BYTES + 1 });
    await pick(big);

    expect(call).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      t('commentsImport.tooLarge', { limit: MAX_XFDF_BYTES / (1024 * 1024) }),
    );
    expect(hasButton(t('commentsImport.import'))).toBe(false);
  });

  it('says so and offers no import when the file has no comments', async () => {
    setup({ 'comments.xfdf_preview': () => ({ comments: 0, replies: 0, pages: [] }) });
    await pick(xfdfFile());

    expect(document.body.textContent).toContain(t('commentsImport.empty'));
    expect(hasButton(t('commentsImport.import'))).toBe(false);
  });

  it('shows the invalid message when the engine refuses the file', async () => {
    setup({
      'comments.xfdf_preview': () => {
        throw new RpcError('REFUSED', 'This file is not valid XFDF.');
      },
    });
    await pick(xfdfFile('not xml'));

    expect(document.body.textContent).toContain(t('commentsImport.invalid'));
    expect(hasButton(t('commentsImport.import'))).toBe(false);
  });

  it('shows the too-large message when the engine reports FILE_TOO_LARGE', async () => {
    setup({
      'comments.xfdf_preview': () => {
        throw new RpcError('FILE_TOO_LARGE', 'too large');
      },
    });
    await pick(xfdfFile());

    expect(document.body.textContent).toContain(
      t('commentsImport.tooLarge', { limit: MAX_XFDF_BYTES / (1024 * 1024) }),
    );
  });
});
