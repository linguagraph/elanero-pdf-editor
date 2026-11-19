import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { OrganizerPanel } from './OrganizerPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a dialog opens (as documents.test.tsx does).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// A fake engine: session.pages lists pageCount pages, and the actions answer at once. A move
// reports the pages it placed, as the engine does; the other actions report nothing.
function fakeRpc(pageCount: number, moveValue: number[] = [1]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let count = pageCount;
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
        if (params.name === 'pages.delete') {
          count -= (params.args as { pages: number[] }).pages.length;
        }
        const value = params.name === 'pages.move' ? moveValue : null;
        return Promise.resolve({
          label: 'x',
          executed: true,
          value,
          changed: null,
          state: {},
        });
      }
      if (method === 'actions.undo') {
        return Promise.resolve({ done: true, label: 'x', changed: null, state: {} });
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

function mount(rpc: PageRpc, store: ToastStore): void {
  act(() => {
    root.render(<OrganizerPanel rpc={rpc} handle="h" onClose={() => {}} toastStore={store} />);
  });
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

// A button by its exact text, in the panel or in a dialog the panel opened.
function buttonNamed(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
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
    click(buttonNamed(t('command.rotate-pages-right.label')));
    await flush();

    expect(calls).toContainEqual({
      method: 'actions.run',
      params: { handle: 'h', name: 'pages.rotate', args: { pages: [0, 2], delta: 90 } },
    });
    const toast = store.getState().visible[0];
    expect(toast?.text).toBe(t('organizer.rotated', { count: 2 }));
    expect(toast?.action?.label).toBe(t('toast.undo'));

    act(() => toast?.action?.run());
    await flush();
    expect(calls.some((call) => call.method === 'actions.undo')).toBe(true);
  });

  it('move down calls pages.move and follows the pages it placed', async () => {
    const { rpc, calls } = fakeRpc(4, [1]);
    mount(rpc, createToastStore());
    await flush();
    click(options()[0]!);
    click(buttonNamed(t('organizer.moveDown')));
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
    click(buttonNamed(t('command.delete-pages.label')));
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
    click(buttonNamed(t('command.delete-pages.label')));
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
