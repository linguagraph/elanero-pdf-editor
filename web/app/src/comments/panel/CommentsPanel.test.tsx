import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../../engine/engineConnection';
import { t } from '../../i18n/t';
import type { CommentDto, CommentListResult, CommentThreadDto } from '../../rpc/generated';
import { CommentsPanel } from './CommentsPanel';
import { CommentsController } from './controller';

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

// The engine's reply, served by a fake rpc. The panel reads the list through the controller.
function setup(
  threads: CommentThreadDto[] = THREADS,
  truncated = false,
): { controller: CommentsController; onGoTo: (page: number, name: string) => void } {
  const reply: CommentListResult = { threads, truncated };
  const controller = new CommentsController({
    rpc: { call: vi.fn(async () => reply) } as unknown as PageRpc,
    handle: 'doc-1',
    scheduler: { subscribeRevisions: () => () => {} },
    debounceMs: 0,
  });
  controller.start();
  return { controller, onGoTo: vi.fn<(page: number, name: string) => void>() };
}

// Opens the panel and waits for its first read.
async function mount(controller: CommentsController, onGoTo: (page: number, name: string) => void) {
  await act(async () => {
    root.render(<CommentsPanel controller={controller} onGoTo={onGoTo} onClose={() => {}} />);
    controller.setOpen(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container.textContent ?? '';
}

// Sets a text field or select the way a user does, so React sees the change.
function change(element: Element, value: string) {
  const proto =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
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

describe('CommentsPanel', () => {
  it('renders each thread with its replies nested under the root', async () => {
    const { controller, onGoTo } = setup();
    await mount(controller, onGoTo);

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
    const { controller, onGoTo } = setup();
    await mount(controller, onGoTo);

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
    const { controller, onGoTo } = setup();
    await mount(controller, onGoTo);

    change(field(t('comments.search')), 'nothing like this');
    expect(text()).toContain(t('comments.noMatch'));
    expect(rows()).toHaveLength(0);
  });

  it('goes to the comment page and name when a row is chosen', async () => {
    const { controller, onGoTo } = setup();
    await mount(controller, onGoTo);

    act(() => rows()[1]?.click());
    expect(onGoTo).toHaveBeenCalledWith(2, 'c2');
  });

  it('shows the empty state through t() when the document has no comments', async () => {
    const { controller, onGoTo } = setup([]);
    await mount(controller, onGoTo);

    expect(text()).toContain(t('comments.empty'));
    expect(container.querySelector('.comments-list')).toBeNull();
  });

  it('says that some comments are not listed when the engine truncated the list', async () => {
    const { controller, onGoTo } = setup(THREADS, true);
    await mount(controller, onGoTo);

    expect(text()).toContain(t('comments.truncated'));
    expect(rows()).toHaveLength(2);
  });
});
