import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../../engine/engineConnection';
import { t } from '../../i18n/t';
import { RpcError } from '../../rpc/client';
import type { CommentDto, CommentListResult, CommentThreadDto } from '../../rpc/generated';
import { CommentsPanel } from './CommentsPanel';
import { CommentsController } from './controller';

// The Undo toast is checked through its offer, so the tests need no toast store.
const offerUndo = vi.hoisted(() => vi.fn());
vi.mock('../../feedback/undoToast', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  offerUndo,
}));

// The reply's author is the name in the preferences; the tests use Eve.
vi.mock('../../prefs/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPreferences: () => ({ authorName: 'Eve' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  offerUndo.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function comment(
  page: number,
  name: string,
  author: string,
  contents: string,
  overrides: Partial<CommentDto> = {},
): CommentDto {
  return {
    page,
    name,
    type: 'Text',
    author,
    contents,
    subject: '',
    created: null,
    modified: null,
    state: 'None',
    locked: false,
    rect: { x0: 0, y0: 0, x1: 10, y1: 10 },
    ...overrides,
  };
}

// Ana's note on page 1 has Ben's reply; Cy's highlight on page 3 is alone and Accepted.
const ANA = comment(0, 'a0', 'Ana', 'Check the total');
const BEN_REPLY = comment(0, 'b0', 'Ben', 'Done');
const CY = comment(2, 'c2', 'Cy', 'Cut this line', { type: 'Highlight' });
const THREADS: CommentThreadDto[] = [
  { comment: ANA, replies: [BEN_REPLY], status: 'Accepted' },
  { comment: CY, replies: [], status: 'None' },
];

// What annotations.run answers for a reply: the history step it made, which Undo offers.
const CHANGED = {
  executed: true,
  label: 'Reply',
  changed: { revisions: {} },
  state: { history: 7 },
};

// The engine's replies, served by a fake rpc: the list for comments.list, and actionReply for
// actions.run. The panel reads the list through the controller.
function setup(threads: CommentThreadDto[] = THREADS, truncated = false, actionReply = CHANGED) {
  const reply: CommentListResult = { threads, truncated };
  const rpc = {
    call: vi.fn(async (method: string) => (method === 'actions.run' ? actionReply : reply)),
  };
  const controller = new CommentsController({
    rpc: rpc as unknown as PageRpc,
    handle: 'doc-1',
    scheduler: { subscribeRevisions: () => () => {} },
    debounceMs: 0,
  });
  controller.start();
  return { controller, rpc, onGoTo: vi.fn<(page: number, name: string) => void>() };
}

type Setup = ReturnType<typeof setup>;

// The app's dialogs, which the panel's Import and Export buttons open.
interface Dialogs {
  readonly onImport: () => void;
  readonly onExport: () => void;
}

function dialogs(): Dialogs {
  return { onImport: vi.fn(), onExport: vi.fn() };
}

function panel(
  { controller, rpc }: Setup,
  onGoTo: (page: number, name: string) => void,
  opened: Dialogs,
) {
  return (
    <CommentsPanel
      controller={controller}
      rpc={rpc as unknown as PageRpc}
      handle="doc-1"
      scheduler={{ noteRevisions: () => {} }}
      onGoTo={onGoTo}
      onClose={() => {}}
      onImport={opened.onImport}
      onExport={opened.onExport}
    />
  );
}

// Opens the panel and waits for its first read.
async function mount(
  setupResult: Setup,
  onGoTo: (page: number, name: string) => void,
  opened: Dialogs = dialogs(),
) {
  const { controller } = setupResult;
  await act(async () => {
    root.render(panel(setupResult, onGoTo, opened));
    controller.setOpen(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function importButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('comments.import.label')}"]`,
  );
}

function exportButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('comments.export.label')}"]`,
  );
}

function toolbarGroup(): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[role="group"][aria-label="${t('comments.toolbar')}"]`,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container.textContent ?? '';
}

// Sets a text field, select or text area the way a user does, so React sees the change.
function change(element: Element, value: string) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
  const type = element instanceof HTMLSelectElement ? 'change' : 'input';
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

function field(label: string): HTMLElement {
  const found = [...container.querySelectorAll('label')].find((el) =>
    el.textContent?.startsWith(label),
  );
  const control = found?.querySelector('input, select');
  if (!(control instanceof HTMLElement)) throw new Error(`no field ${label}`);
  return control;
}

function rows(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.comments-list > li > button')];
}

// The Reply button of the thread at `index`, and the thread's status menu.
function replyButton(index: number): HTMLButtonElement {
  const found = container.querySelectorAll<HTMLButtonElement>('.comments-thread-actions button')[
    index
  ];
  if (found === undefined) throw new Error(`no reply button ${index}`);
  return found;
}

function statusMenu(index: number): HTMLSelectElement {
  const found = container.querySelectorAll<HTMLSelectElement>('.comments-thread-actions select')[
    index
  ];
  if (found === undefined) throw new Error(`no status menu ${index}`);
  return found;
}

function replyText(): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>('.comments-reply-box textarea');
}

function postButton(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    '.comments-reply-box button[type="submit"]',
  );
  if (found === null) throw new Error('no post button');
  return found;
}

describe('CommentsPanel', () => {
  it('renders each thread with its replies nested under the root', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    const threads = container.querySelectorAll('.comments-list > li');
    expect(threads).toHaveLength(2);
    expect(threads[0]?.querySelector('.comments-replies')?.textContent).toContain('Done');
    expect(threads[1]?.querySelector('.comments-replies')).toBeNull();
    expect(text()).toContain('Check the total');
    expect(text()).toContain(t('comments.page', { page: 1 }));
    expect(text()).toContain(t('comment.type.Highlight'));
    expect(text()).toContain(t('comment.status.Accepted'));
  });

  it('filters the list by search, author and type', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    // A reply's author keeps its whole thread.
    change(field(t('comments.filter.author')), 'Ben');
    expect(rows().map((row) => row.textContent)).toHaveLength(1);
    expect(text()).toContain('Check the total');

    change(field(t('comments.filter.author')), '');
    change(field(t('comments.search')), 'cut');
    expect(rows()).toHaveLength(1);
    expect(text()).toContain('Cut this line');

    change(field(t('comments.search')), '');
    change(field(t('comments.filter.type')), 'Text');
    expect(rows()).toHaveLength(1);
    expect(text()).not.toContain('Cut this line');
  });

  it('shows a no-match line when the filters hide every thread', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    change(field(t('comments.search')), 'nothing like this');
    expect(text()).toContain(t('comments.noMatch'));
    expect(rows()).toHaveLength(0);
  });

  it('goes to the comment page and name when a row is chosen', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    act(() => rows()[1]?.click());
    expect(setupResult.onGoTo).toHaveBeenCalledWith(2, 'c2');
  });

  it('shows the empty state through t() when the document has no comments', async () => {
    const setupResult = setup([]);
    await mount(setupResult, setupResult.onGoTo);

    expect(text()).toContain(t('comments.empty'));
    expect(container.querySelector('.comments-list')).toBeNull();
  });

  it('says that some comments are not listed when the engine truncated the list', async () => {
    const setupResult = setup(THREADS, true);
    await mount(setupResult, setupResult.onGoTo);

    expect(text()).toContain(t('comments.truncated'));
    expect(rows()).toHaveLength(2);
  });

  it('sends a reply to the thread with the author, and offers Undo for it', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    act(() => replyButton(0).click());
    change(replyText() as HTMLTextAreaElement, '  Thanks, fixed  ');
    await act(async () => postButton().click());
    await settle();

    expect(setupResult.rpc.call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'annotations.reply',
      args: {
        parent: { page: 0, name: 'a0' },
        text: 'Thanks, fixed',
        author: 'Eve',
        state: 'None',
      },
    });
    expect(offerUndo).toHaveBeenCalledWith(
      'info',
      t('comments.reply.added'),
      expect.objectContaining({ handle: 'doc-1', history: 7 }),
    );
    expect(replyText()).toBeNull();
  });

  it('keeps Post disabled for a blank reply, and sends nothing', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    act(() => replyButton(1).click());
    change(replyText() as HTMLTextAreaElement, '   ');
    expect(postButton().disabled).toBe(true);
    await act(async () => postButton().click());
    await settle();

    expect(setupResult.rpc.call).not.toHaveBeenCalledWith('actions.run', expect.anything());
    expect(offerUndo).not.toHaveBeenCalled();
  });

  it('closes the reply box on Escape without sending', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    act(() => replyButton(0).click());
    act(() => {
      replyText()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(replyText()).toBeNull();
    expect(setupResult.rpc.call).not.toHaveBeenCalledWith('actions.run', expect.anything());
  });

  it('keeps the reply box open when the engine refuses the reply', async () => {
    const setupResult = setup();
    setupResult.rpc.call.mockImplementation(async (method: string) => {
      if (method === 'actions.run') throw new Error('engine down');
      return { threads: THREADS, truncated: false };
    });
    await mount(setupResult, setupResult.onGoTo);

    act(() => replyButton(0).click());
    change(replyText() as HTMLTextAreaElement, 'Thanks');
    await act(async () => postButton().click());
    await settle();

    expect(replyText()?.value).toBe('Thanks');
    expect(offerUndo).not.toHaveBeenCalled();
  });

  it('sets the status of the thread from its menu, and offers Undo', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    await act(async () => {
      change(statusMenu(1), 'Rejected');
    });
    await settle();

    expect(setupResult.rpc.call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'annotations.reply',
      args: { parent: { page: 2, name: 'c2' }, text: '', author: 'Eve', state: 'Rejected' },
    });
    expect(offerUndo).toHaveBeenCalledWith(
      'info',
      t('comments.status.done'),
      expect.objectContaining({ handle: 'doc-1' }),
    );
    expect(statusMenu(1).value).toBe('');
  });

  it('edits the text of a thread root, and offers Undo for the change', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    act(() => editButton(0).click());
    expect(replyText()?.value).toBe('Check the total');
    change(replyText() as HTMLTextAreaElement, 'Revised total');
    await act(async () => postButton().click());
    await settle();

    expect(setupResult.rpc.call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'annotations.set_text',
      args: { ref: { page: 0, name: 'a0' }, text: 'Revised total' },
    });
    expect(offerUndo).toHaveBeenCalledWith(
      'info',
      t('comments.edit.done'),
      expect.objectContaining({ handle: 'doc-1', history: 7 }),
    );
    expect(replyText()).toBeNull();
  });

  it('closes the editor on Escape without sending', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    act(() => editButton(1).click());
    act(() => {
      replyText()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(replyText()).toBeNull();
    expect(setupResult.rpc.call).not.toHaveBeenCalledWith('actions.run', expect.anything());
  });

  it('deletes a thread from its Delete button, and offers Undo', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    await act(async () => deleteButton(1).click());
    await settle();

    expect(setupResult.rpc.call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'annotations.delete',
      args: { refs: [{ page: 2, name: 'c2' }] },
    });
    expect(offerUndo).toHaveBeenCalledWith(
      'info',
      t('comments.delete.done'),
      expect.objectContaining({ handle: 'doc-1', history: 7 }),
    );
  });

  it('deletes the focused thread on the Delete and Backspace keys', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);

    await act(async () => {
      rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await settle();
    await act(async () => {
      rows()[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    await settle();

    expect(setupResult.rpc.call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'annotations.delete',
      args: { refs: [{ page: 0, name: 'a0' }] },
    });
    expect(setupResult.rpc.call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'annotations.delete',
      args: { refs: [{ page: 2, name: 'c2' }] },
    });
  });

  it('disables Edit and Delete for a locked comment, and the Delete key does nothing', async () => {
    const locked: CommentThreadDto[] = [
      {
        comment: comment(0, 'a0', 'Ana', 'Locked note', { locked: true }),
        replies: [],
        status: 'None',
      },
    ];
    const setupResult = setup(locked);
    await mount(setupResult, setupResult.onGoTo);

    expect(editButton(0).disabled).toBe(true);
    expect(deleteButton(0).disabled).toBe(true);
    await act(async () => {
      rows()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await settle();

    expect(setupResult.rpc.call).not.toHaveBeenCalledWith('actions.run', expect.anything());
    expect(offerUndo).not.toHaveBeenCalled();
  });

  it('reads the list again and keeps the editor open when the comment is stale', async () => {
    const setupResult = setup();
    await mount(setupResult, setupResult.onGoTo);
    const listCalls = () =>
      setupResult.rpc.call.mock.calls.filter(([method]) => method === 'comments.list').length;
    const before = listCalls();
    setupResult.rpc.call.mockImplementation(async (method: string) => {
      if (method === 'actions.run') throw new RpcError('STALE_OBJECT', 'gone');
      return { threads: THREADS, truncated: false };
    });

    act(() => editButton(0).click());
    change(replyText() as HTMLTextAreaElement, 'Too late');
    await act(async () => postButton().click());
    await settle();

    expect(offerUndo).not.toHaveBeenCalled();
    expect(listCalls()).toBeGreaterThan(before);
    expect(replyText()?.value).toBe('Too late');
  });
});

function editButton(index: number): HTMLButtonElement {
  return threadEditButtons()[index * 2] as HTMLButtonElement;
}

function deleteButton(index: number): HTMLButtonElement {
  return threadEditButtons()[index * 2 + 1] as HTMLButtonElement;
}

function threadEditButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.comments-thread-edit button')];
}

describe('CommentsPanel toolbar (W7.1b S1)', () => {
  it('shows Import in every state, and Export only with a list that has threads', async () => {
    // Loading: the read has not come back yet, so the list is not loaded.
    const loading = setup();
    act(() => {
      root.render(panel(loading, loading.onGoTo, dialogs()));
      loading.controller.setOpen(true);
    });
    expect(importButton()).not.toBeNull();
    expect(exportButton()).toBeNull();
    expect(text()).toContain(t('comments.loading'));
    await settle();

    // Loaded with threads: both.
    act(() => root.unmount());
    root = createRoot(container);
    const listed = setup();
    await mount(listed, listed.onGoTo);
    expect(importButton()).not.toBeNull();
    expect(exportButton()).not.toBeNull();
    // Both buttons sit in the labelled toolbar group, not loose in the panel.
    expect(toolbarGroup()).not.toBeNull();
    expect(toolbarGroup()?.contains(importButton())).toBe(true);
    expect(toolbarGroup()?.contains(exportButton())).toBe(true);

    // Loaded with no threads: Import only.
    act(() => root.unmount());
    root = createRoot(container);
    const empty = setup([]);
    await mount(empty, empty.onGoTo);
    expect(text()).toContain(t('comments.empty'));
    expect(importButton()).not.toBeNull();
    expect(exportButton()).toBeNull();
    expect(toolbarGroup()?.contains(importButton())).toBe(true);
  });

  it('opens the app dialogs from the Import and Export buttons', async () => {
    const setupResult = setup();
    const opened = dialogs();
    await mount(setupResult, setupResult.onGoTo, opened);

    act(() => importButton()?.click());
    expect(opened.onImport).toHaveBeenCalledTimes(1);
    expect(opened.onExport).not.toHaveBeenCalled();

    act(() => exportButton()?.click());
    expect(opened.onExport).toHaveBeenCalledTimes(1);
  });

  it('keeps the Import button when the list loads, so focus can return to it', async () => {
    const setupResult = setup();
    act(() => {
      root.render(panel(setupResult, setupResult.onGoTo, dialogs()));
      setupResult.controller.setOpen(true);
    });
    const before = importButton();
    expect(before).not.toBeNull();
    await settle();
    expect(importButton()).toBe(before);
    expect(container.querySelector('.comments-list')).not.toBeNull();
  });
});
