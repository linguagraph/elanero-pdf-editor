import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createPasswordPrompt, type PasswordPrompt } from '../documents/passwordRequest';
import { jobProgress } from '../feedback/jobRun';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import type { JobWorker } from '../files/fileJob';
import { RpcError } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { t, tp } from '../i18n/t';
import { OrganizerPanel } from './OrganizerPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a dialog opens (as documents.test.tsx does).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// The pages an insert from file adds in these tests.
const INSERTED = 2;

// A fake engine: session.pages lists pageCount pages, and the actions answer at once. A move
// reports the pages it placed, as the engine does; the other actions report nothing. An insert from
// file adds INSERTED pages, and a file locked with `locked` asks for that password first. The split
// job (the extract) answers with one file, and jobs.abort answers at once.
function fakeRpc(pageCount: number, moveValue: number[] = [1], locked?: string) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let count = pageCount;
  // The page count before each action, so an undo can restore it.
  const counts: number[] = [];
  const rpc = {
    call: vi.fn((method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'session.pages') {
        const pages = Array.from({ length: count }, () => ({
          width: 612,
          height: 792,
          rotation: 0,
        }));
        return Promise.resolve({ pages });
      }
      if (method === 'actions.run') {
        counts.push(count);
        if (params.name === 'pages.insert_file') {
          const { password } = params.args as { password: string | null };
          if (locked !== undefined && password !== locked) {
            counts.pop();
            return Promise.reject(new RpcError('PASSWORD_REQUIRED', 'password protected'));
          }
          count += INSERTED;
          return Promise.resolve({
            label: 'Insert Pages',
            executed: true,
            value: INSERTED,
            changed: null,
            state: {},
          });
        }
        if (params.name === 'pages.delete') {
          count -= (params.args as { pages: number[] }).pages.length;
        }
        if (params.name === 'pages.insert_blank') count += 1;
        if (params.name === 'pages.duplicate') {
          count += (params.args as { pages: number[] }).pages.length;
        }
        const value = params.name === 'pages.move' ? moveValue : null;
        return Promise.resolve({
          label: 'x',
          executed: true,
          value,
          changed: null,
          state: { history: 3 },
        });
      }
      if (method === 'actions.undo') {
        count = counts.pop() ?? count;
        return Promise.resolve({ done: true, label: 'x', changed: null, state: {} });
      }
      if (method === 'jobs.prepare') {
        return Promise.resolve({
          token: 'j1',
          label: 'split',
          mutating: false,
          document: new ArrayBuffer(4),
          state: null,
        });
      }
      if (method === 'jobs.apply' || method === 'jobs.abort') {
        return Promise.resolve({ applied: false, changed: null, state: null });
      }
      const request = params as { revision: number };
      return Promise.resolve({
        width: 1,
        height: 1,
        revision: request.revision,
        format: 'rgba' as const,
        pixels: new ArrayBuffer(4),
      });
    }),
  };
  return { rpc: rpc as unknown as PageRpc, calls };
}

const context = {
  createImageData: vi.fn((width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  })),
  putImageData: vi.fn(),
};

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// What the extract's job worker answers: one PDF, whose bytes are the reply's buffer.
function extractWorker(): JobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [{ name: 'split/part-1.pdf', mime: 'application/pdf', data: { $bin: 0 } }],
      value: null,
      name: '',
    },
    events: [],
  };
  const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
  return {
    call: vi.fn(() => Promise.resolve({ reply: JSON.stringify(reply), buffers: [bytes] })),
    terminate: vi.fn(),
  } as unknown as JobWorker;
}

interface MountOptions {
  readonly prompt?: PasswordPrompt;
  readonly download?: (name: string, bytes: ArrayBuffer) => void;
  readonly worker?: () => JobWorker;
}

function mount(
  rpc: PageRpc,
  store: ToastStore,
  onChanged?: (pageCount: number) => void,
  options: MountOptions = {},
): void {
  act(() => {
    root.render(
      <OrganizerPanel
        rpc={rpc}
        handle="h"
        onClose={() => {}}
        toastStore={store}
        onChanged={onChanged}
        documentName="doc.pdf"
        startWorker={options.worker ?? extractWorker}
        download={options.download}
        prompt={options.prompt}
      />,
    );
  });
}

// A PDF the test can read. jsdom's File has no arrayBuffer(), so the test supplies one that gives a
// fresh copy each time, as a read of a File does.
function pdfFile(name: string): File {
  const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
  const file = new File([bytes], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice(0) });
  return file;
}

// Chooses a file in the panel's hidden file input, as the user does in the file dialog.
function chooseFile(file: File): void {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function insertCalls(calls: { method: string; params: Record<string, unknown> }[]) {
  return calls.filter((call) => call.params.name === 'pages.insert_file');
}

function options(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
}

function selectedPages(): number[] {
  return options()
    .map((option, index) => (option.getAttribute('aria-selected') === 'true' ? index : -1))
    .filter((index) => index >= 0);
}

function click(element: Element, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
  });
}

// A press on a react-aria button (the dialog's), which reacts to key presses rather than clicks.
function press(element: Element) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  });
}

// A toolbar icon button by its label (aria-label), else a button by its exact text. The toolbar is
// searched first, so a dialog's button with the same text (Delete) is found only when the toolbar
// has none with that label.
function buttonNamed(text: string): HTMLButtonElement {
  const inToolbar = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
  ).find((button) => button.getAttribute('aria-label') === text);
  const found =
    inToolbar ??
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === text,
    );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

describe('page organizer selection', () => {
  it('lists the pages and starts with none selected', async () => {
    const { rpc } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    expect(options()).toHaveLength(4);
    expect(selectedPages()).toEqual([]);
  });

  it('click, Ctrl-click and Shift-click select the expected pages', async () => {
    const { rpc } = fakeRpc(6);
    mount(rpc, createToastStore());
    await flush();
    click(options()[1]!);
    expect(selectedPages()).toEqual([1]);
    click(options()[4]!, { ctrlKey: true });
    expect(selectedPages()).toEqual([1, 4]);
    // The Ctrl-click left page 4 as the anchor, so Shift-click reaches back from there.
    click(options()[2]!, { shiftKey: true });
    expect(selectedPages()).toEqual([2, 3, 4]);
  });
});

describe('page organizer actions', () => {
  it('rotates the selected pages and offers Undo, which calls actions.undo', async () => {
    const { rpc, calls } = fakeRpc(4);
    const store = createToastStore();
    mount(rpc, store);
    await flush();
    click(options()[0]!);
    click(options()[2]!, { ctrlKey: true });
    press(buttonNamed(t('command.rotate-pages-right.label')));
    await flush();

    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.rotate', args: { pages: [0, 2], delta: 90 } },
    });
    const toast = store.getState().visible[0];
    expect(toast?.text).toBe(tp('organizer.rotated', 2));
    expect(toast?.action?.label).toBe(t('toast.undo'));

    act(() => toast?.action?.run());
    await flush();
    // The Undo names the rotate's history, so a press after a later change is refused.
    expect(calls).toContainEqual({
      method: 'actions.undo',
      params: { handle: 'h', expect_history: 3 },
    });
  });

  it('move down calls pages.move and follows the pages it placed', async () => {
    const { rpc, calls } = fakeRpc(4, [1]);
    mount(rpc, createToastStore());
    await flush();
    click(options()[0]!);
    press(buttonNamed(t('organizer.moveDown')));
    await flush();
    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.move', args: { pages: [0], before: 2 } },
    });
    expect(selectedPages()).toEqual([1]);
  });

  it('delete asks first, and cancelling does nothing', async () => {
    const { rpc, calls } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    click(options()[1]!);
    press(buttonNamed(t('command.delete-pages.label')));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press(buttonNamed(t('organizer.cancel')));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(calls.some((call) => call.method === 'actions.run')).toBe(false);
  });

  it('confirming delete calls pages.delete for the selection', async () => {
    const { rpc, calls } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    click(options()[1]!);
    press(buttonNamed(t('command.delete-pages.label')));
    // The toolbar's Delete and the dialog's Delete share a label, so the dialog's is looked up apart.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    press(
      Array.from(dialog?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent === t('organizer.deleteConfirm'),
      ) as HTMLButtonElement,
    );
    await flush();
    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.delete', args: { pages: [1] } },
    });
  });

  it('never offers to delete every page', async () => {
    const { rpc, calls } = fakeRpc(3);
    mount(rpc, createToastStore());
    await flush();
    click(options()[0]!);
    click(options()[2]!, { shiftKey: true });
    expect(buttonNamed(t('command.delete-pages.label')).disabled).toBe(true);
    expect(host.textContent).toContain(t('organizer.keepOne'));
    expect(calls.some((call) => call.method === 'actions.run')).toBe(false);
  });
});

describe('page organizer toolbar', () => {
  it('every toolbar icon button has its label as its name and an icon, and rotate and move need a selection', async () => {
    const { rpc } = fakeRpc(3);
    mount(rpc, createToastStore());
    await flush();

    const labels = [
      t('command.rotate-pages-left.label'),
      t('command.rotate-pages-right.label'),
      t('organizer.insertBlank'),
      t('organizer.insertFile'),
      t('command.duplicate-pages.label'),
      t('command.extract-pages.label'),
      t('organizer.moveUp'),
      t('organizer.moveDown'),
      t('command.delete-pages.label'),
    ];
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'),
    );
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(labels);
    for (const button of buttons) {
      expect(button.textContent).toBe('');
      expect(button.querySelector('svg')).not.toBeNull();
    }

    expect(buttonNamed(t('command.rotate-pages-left.label')).disabled).toBe(true);
    expect(buttonNamed(t('command.rotate-pages-right.label')).disabled).toBe(true);
    expect(buttonNamed(t('organizer.moveUp')).disabled).toBe(true);
    expect(buttonNamed(t('organizer.moveDown')).disabled).toBe(true);
    expect(buttonNamed(t('organizer.insertBlank')).disabled).toBe(false);
  });
});

describe('page organizer insert and duplicate', () => {
  it('insert blank with no selection adds the page at the end and selects it', async () => {
    const { rpc, calls } = fakeRpc(4);
    const store = createToastStore();
    mount(rpc, store);
    await flush();
    press(buttonNamed(t('organizer.insertBlank')));
    await flush();
    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.insert_blank', args: { at: 4 } },
    });
    expect(options()).toHaveLength(5);
    expect(selectedPages()).toEqual([4]);
    expect(store.getState().visible[0]?.text).toBe(tp('organizer.inserted', 1));
  });

  it('insert blank after the last selected page selects the new page', async () => {
    const { rpc, calls } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    click(options()[1]!);
    click(options()[3]!, { ctrlKey: true });
    press(buttonNamed(t('organizer.insertBlank')));
    await flush();
    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.insert_blank', args: { at: 4 } },
    });
    expect(selectedPages()).toEqual([4]);
  });

  it('duplicate sends the selection and selects the copies', async () => {
    const { rpc, calls } = fakeRpc(4);
    const store = createToastStore();
    mount(rpc, store);
    await flush();
    click(options()[0]!);
    click(options()[1]!, { shiftKey: true });
    press(buttonNamed(t('command.duplicate-pages.label')));
    await flush();
    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.duplicate', args: { pages: [0, 1] } },
    });
    expect(options()).toHaveLength(6);
    expect(selectedPages()).toEqual([2, 3]);
    expect(store.getState().visible[0]?.text).toBe(tp('organizer.duplicated', 2));
  });

  it('duplicate needs a selection', async () => {
    const { rpc } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    expect(buttonNamed(t('command.duplicate-pages.label')).disabled).toBe(true);
  });

  it('reports the new page count to onChanged, and Undo reloads the pages', async () => {
    const { rpc, calls } = fakeRpc(4);
    const store = createToastStore();
    const onChanged = vi.fn();
    mount(rpc, store, onChanged);
    await flush();
    click(options()[0]!);
    press(buttonNamed(t('command.duplicate-pages.label')));
    await flush();
    expect(onChanged).toHaveBeenLastCalledWith(5);

    const listed = calls.filter((call) => call.method === 'session.pages').length;
    const toast = store.getState().visible[0];
    expect(toast?.action?.label).toBe(t('toast.undo'));
    act(() => toast?.action?.run());
    await flush();
    expect(calls.some((call) => call.method === 'actions.undo')).toBe(true);
    expect(calls.filter((call) => call.method === 'session.pages').length).toBeGreaterThan(listed);
    expect(onChanged).toHaveBeenLastCalledWith(4);
  });
});

describe('page organizer insert from file', () => {
  it('inserts the file after the last selected page and selects the pages it brought', async () => {
    const { rpc, calls } = fakeRpc(4);
    const store = createToastStore();
    mount(rpc, store);
    await flush();
    click(options()[1]!);
    chooseFile(pdfFile('scan.pdf'));
    await flush();
    expect(insertCalls(calls)[0]?.params.args).toMatchObject({
      name: 'scan.pdf',
      at: 2,
      pages: null,
      password: null,
    });
    expect(options()).toHaveLength(4 + INSERTED);
    expect(selectedPages()).toEqual([2, 3]);
    expect(store.getState().visible[0]?.text).toBe(tp('organizer.inserted', INSERTED));
  });

  it('asks for the password of a locked file once and inserts it with the answer', async () => {
    const { rpc, calls } = fakeRpc(4, [1], 'secret');
    const prompt = createPasswordPrompt();
    const ask = vi.spyOn(prompt, 'ask').mockResolvedValue('secret');
    mount(rpc, createToastStore(), undefined, { prompt });
    await flush();
    chooseFile(pdfFile('locked.pdf'));
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('locked.pdf');
    const passwords = insertCalls(calls).map(
      (call) => (call.params.args as { password: unknown }).password,
    );
    expect(passwords).toEqual([null, 'secret']);
    expect(options()).toHaveLength(4 + INSERTED);
  });

  it('a cancelled password dialog inserts nothing and shows nothing', async () => {
    const { rpc } = fakeRpc(4, [1], 'secret');
    const prompt = createPasswordPrompt();
    const ask = vi.spyOn(prompt, 'ask').mockResolvedValue(null);
    const store = createToastStore();
    mount(rpc, store, undefined, { prompt });
    await flush();
    chooseFile(pdfFile('locked.pdf'));
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(options()).toHaveLength(4);
    expect(store.getState().visible).toHaveLength(0);
  });

  it('stops after five password answers and says the file is still locked', async () => {
    const { rpc, calls } = fakeRpc(4, [1], 'secret');
    const prompt = createPasswordPrompt();
    const ask = vi.spyOn(prompt, 'ask').mockResolvedValue('wrong');
    const store = createToastStore();
    mount(rpc, store, undefined, { prompt });
    await flush();
    chooseFile(pdfFile('locked.pdf'));
    await flush();
    expect(ask).toHaveBeenCalledTimes(5);
    expect(insertCalls(calls)).toHaveLength(6);
    expect(options()).toHaveLength(4);
    expect(store.getState().visible[0]?.text).toBe(t('organizer.passwordGaveUp'));
  });
});

describe('page organizer extract', () => {
  it('downloads the selected pages as "<name> (extract).pdf" with no Undo', async () => {
    const { rpc, calls } = fakeRpc(4);
    const store = createToastStore();
    const download = vi.fn();
    mount(rpc, store, undefined, { download });
    await flush();
    click(options()[1]!);
    click(options()[3]!, { ctrlKey: true });
    press(buttonNamed(t('command.extract-pages.label')));
    await flush();
    expect(calls).toContainEqual({
      method: 'jobs.prepare',
      params: {
        handle: 'h',
        job: 'split',
        args: {
          mode: 'ranges',
          pages_per_file: 1,
          ranges: [[1, 3]],
          max_bytes: 0,
          name: '',
          zip: false,
        },
      },
    });
    expect(download).toHaveBeenCalledWith('doc (extract).pdf', expect.any(ArrayBuffer));
    expect(calls.filter((call) => call.method === 'actions.run')).toHaveLength(0);
    const shown = store.getState().visible[0];
    expect(shown?.text).toBe(tp('organizer.extracted', 2, { name: 'doc (extract).pdf' }));
    expect(shown?.action).toBeUndefined();
    expect(options()).toHaveLength(4);
  });

  it('a cancelled extract downloads nothing and shows nothing', async () => {
    const { rpc } = fakeRpc(4);
    const store = createToastStore();
    const download = vi.fn();
    const worker = (): JobWorker =>
      ({
        call: vi.fn(() => new Promise<never>(() => undefined)),
        terminate: vi.fn(),
      }) as unknown as JobWorker;
    mount(rpc, store, undefined, { download, worker });
    await flush();
    click(options()[0]!);
    press(buttonNamed(t('command.extract-pages.label')));
    await flush();
    await act(async () => {
      await jobProgress.cancel();
    });
    await flush();
    expect(download).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(0);
  });
});

// jsdom has no layout. The grid is 300 px wide and its cells are 100 px squares in three columns:
// page i sits at column i % 3, row floor(i / 3).
function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'listbox') {
      return { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 } as DOMRect;
    }
    const page = Number((this as HTMLElement).dataset.page);
    if (!Number.isInteger(page)) return { left: 0, top: 0, right: 0, bottom: 0 } as DOMRect;
    const left = (page % 3) * 100;
    const top = Math.floor(page / 3) * 100;
    return { left, top, right: left + 100, bottom: top + 100, width: 100, height: 100 } as DOMRect;
  });
}

function pointer(target: Element, type: string, x: number, y: number, pointerType = 'mouse'): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

function grid(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[role="listbox"]');
  if (el === null) throw new Error('no listbox');
  return el;
}

// Presses on option `from`, drags past the threshold and on to (x, y), and returns the grid.
function dragTo(from: number, x: number, y: number): HTMLElement {
  const source = options()[from];
  if (source === undefined) throw new Error(`no option ${from}`);
  pointer(source, 'pointerdown', 50, 50);
  pointer(grid(), 'pointermove', 60, 50);
  pointer(grid(), 'pointermove', x, y);
  return grid();
}

describe('page organizer drag and drop', () => {
  beforeEach(() => {
    stubLayout();
  });

  it('dragging page 1 past page 3 moves it there, selects it, and offers Undo', async () => {
    const { rpc, calls } = fakeRpc(4, [2]);
    const store = createToastStore();
    mount(rpc, store);
    await flush();
    // Right of page 3's centre in the first row: the drop lands after it.
    dragTo(0, 270, 50);
    pointer(grid(), 'pointerup', 270, 50);
    await flush();

    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.move', args: { pages: [0], before: 3 } },
    });
    expect(selectedPages()).toEqual([2]);
    const toast = store.getState().visible[0];
    expect(toast?.text).toBe(tp('organizer.moved', 1));
    expect(toast?.action?.label).toBe(t('toast.undo'));
  });

  it('a drag of a selected page carries the whole selection', async () => {
    const { rpc, calls } = fakeRpc(5, [3, 4]);
    mount(rpc, createToastStore());
    await flush();
    click(options()[0]!);
    click(options()[2]!, { ctrlKey: true });
    dragTo(2, 270, 50);
    pointer(grid(), 'pointerup', 270, 50);
    await flush();
    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.move', args: { pages: [0, 2], before: 3 } },
    });
  });

  it('a drop in place sends no pages.move', async () => {
    const { rpc, calls } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    // Page 1 dropped in front of page 2 (its own next slot): nothing changes.
    dragTo(1, 160, 50);
    pointer(grid(), 'pointerup', 160, 50);
    await flush();
    expect(calls.filter((call) => call.params.name === 'pages.move')).toHaveLength(0);
  });

  it('shows the drop marker and the status while dragging, and clears both after the drop', async () => {
    const { rpc } = fakeRpc(4, [2]);
    mount(rpc, createToastStore());
    await flush();
    dragTo(0, 270, 50);
    const status = host.querySelector('.organizer-status[aria-live="polite"]');
    // The drop is before original page index 3, which the status calls position 4.
    expect(status?.textContent).toBe(tp('organizer.dragging', 1, { position: 4 }));
    expect(options()[0]?.dataset.dragging).toBe('true');
    expect(options()[2]?.dataset.drop).toBe('after');
    expect(grid().dataset.dragging).toBe('true');

    pointer(grid(), 'pointerup', 270, 50);
    await flush();
    expect(options()[0]?.dataset.dragging).toBeUndefined();
    expect(options()[2]?.dataset.drop).toBeUndefined();
    expect(grid().dataset.dragging).toBeUndefined();
  });

  it('Escape during a drag sends nothing and clears the marker', async () => {
    const { rpc, calls } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    dragTo(0, 270, 50);
    act(() => {
      grid().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    pointer(grid(), 'pointerup', 270, 50);
    await flush();
    expect(calls.filter((call) => call.params.name === 'pages.move')).toHaveLength(0);
    expect(grid().dataset.dragging).toBeUndefined();
  });

  it('the click that follows a drag does not change the selection', async () => {
    const { rpc } = fakeRpc(4, [2]);
    mount(rpc, createToastStore());
    await flush();
    dragTo(0, 270, 50);
    pointer(grid(), 'pointerup', 270, 50);
    await flush();
    expect(selectedPages()).toEqual([2]);
    click(options()[0]!);
    expect(selectedPages()).toEqual([2]);
  });

  it('the keyboard can select a page and then reach Move down', async () => {
    const { rpc } = fakeRpc(4);
    mount(rpc, createToastStore());
    await flush();
    // Keyboard path: Enter on a page selects it (no pointer); Move down is a real, enabled button.
    const first = options()[0]!;
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const moveDown = buttonNamed(t('organizer.moveDown'));
    expect(moveDown.disabled).toBe(false);
    expect(moveDown.tabIndex).not.toBe(-1);
  });
});
