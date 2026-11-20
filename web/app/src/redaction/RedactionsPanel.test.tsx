import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import type { RedactionController, RedactionMark, RedactionSnapshot } from './controller';
import { SelectedMarkOutlines } from './RedactLayer';
import type { MarkRef } from './marks';
import { RedactionsPanel } from './RedactionsPanel';

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

function mark(page: number, name: string, overrides: Partial<RedactionMark> = {}): RedactionMark {
  return {
    page,
    name,
    rect: { x0: 1, y0: 2, x1: 30, y1: 40 },
    fill: null,
    overlayText: '',
    textColor: null,
    contents: '',
    author: '',
    locked: false,
    ...overrides,
  };
}

// A controller stand-in with the real subscribe/getSnapshot shape: the panel reads it, and the
// calls the panel makes are recorded.
function fakeController(marks: RedactionMark[], selected: MarkRef[] = [], loaded = true) {
  let snapshot: RedactionSnapshot = { active: false, marks, selected, busy: false, loaded };
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    select: vi.fn((refs: readonly MarkRef[]) => {
      snapshot = { ...snapshot, selected: [...refs] };
      for (const listener of listeners) listener();
    }),
    remove: vi.fn(async () => undefined),
  };
}

type Fake = ReturnType<typeof fakeController>;

function render(controller: Fake, onGoTo = vi.fn(), onClose = vi.fn()) {
  act(() => {
    root.render(
      <RedactionsPanel
        controller={controller as unknown as RedactionController}
        onGoTo={onGoTo}
        onClose={onClose}
      />,
    );
  });
  return { onGoTo, onClose };
}

function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

function key(element: Element, keyName: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
}

function click(element: Element, modifiers: MouseEventInit = {}) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifiers }));
  });
}

describe('RedactionsPanel', () => {
  it('shows the empty state when the document has no marks', () => {
    render(fakeController([]));
    expect(container.textContent).toContain(t('redactions.empty'));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('shows the loading state until the first list has come back', () => {
    render(fakeController([], [], false));
    expect(container.textContent).toContain(t('redactions.loading'));
  });

  it('shows the page, the marked text or "Area", and the overlay of each row', () => {
    render(
      fakeController([
        mark(0, 'm1', { contents: 'SECRET' }),
        mark(2, 'm2', { overlayText: 'EXEMPT' }),
      ]),
    );
    const [first, second] = rows();
    expect(first?.textContent).toContain(t('redactions.page', { page: 1 }));
    expect(first?.textContent).toContain('SECRET');
    expect(second?.textContent).toContain(t('redactions.page', { page: 3 }));
    expect(second?.textContent).toContain(t('redactions.area'));
    expect(second?.textContent).toContain(t('redactions.overlay', { text: 'EXEMPT' }));
    expect(first?.textContent).not.toContain(t('redactions.overlay', { text: '' }));
  });

  it('is a multi-select listbox', () => {
    render(fakeController([mark(0, 'm1')]));
    const list = container.querySelector('[role="listbox"]');
    expect(list?.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('a click picks one row, and Ctrl and Shift extend the selection', () => {
    const controller = fakeController([mark(0, 'a'), mark(0, 'b'), mark(1, 'c')]);
    render(controller);
    click(rows()[0] as HTMLElement);
    expect(controller.select).toHaveBeenLastCalledWith([{ page: 0, name: 'a' }]);
    click(rows()[2] as HTMLElement, { ctrlKey: true });
    expect(controller.select).toHaveBeenLastCalledWith([
      { page: 0, name: 'a' },
      { page: 1, name: 'c' },
    ]);
    click(rows()[1] as HTMLElement, { shiftKey: true });
    expect(controller.select).toHaveBeenLastCalledWith([
      { page: 0, name: 'b' },
      { page: 1, name: 'c' },
    ]);
  });

  it('Enter and a double-click go to the mark page', () => {
    const { onGoTo } = render(fakeController([mark(0, 'a'), mark(3, 'b')]));
    key(rows()[1] as HTMLElement, 'Enter');
    expect(onGoTo).toHaveBeenLastCalledWith(3);
    act(() => {
      rows()[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onGoTo).toHaveBeenLastCalledWith(0);
  });

  it('Delete calls remove with the selection, and is disabled with none', () => {
    const controller = fakeController([mark(0, 'a'), mark(0, 'b')], [{ page: 0, name: 'b' }]);
    render(controller);
    const button = buttonNamed(t('redactions.delete'));
    expect(button.disabled).toBe(false);
    click(button);
    expect(controller.remove).toHaveBeenCalledWith([{ page: 0, name: 'b' }]);
  });

  it('Delete is disabled when nothing is selected', () => {
    render(fakeController([mark(0, 'a')]));
    expect(buttonNamed(t('redactions.delete')).disabled).toBe(true);
  });

  it('marks the selected row with aria-selected and puts one row in the tab order', () => {
    render(fakeController([mark(0, 'a'), mark(0, 'b')], [{ page: 0, name: 'b' }]));
    const [first, second] = rows();
    expect(first?.getAttribute('aria-selected')).toBe('false');
    expect(second?.getAttribute('aria-selected')).toBe('true');
    expect(second?.tabIndex).toBe(0);
    expect(first?.tabIndex).toBe(-1);
  });

  it('Escape clears the selection', () => {
    const controller = fakeController([mark(0, 'a')], [{ page: 0, name: 'a' }]);
    render(controller);
    key(rows()[0] as HTMLElement, 'Escape');
    expect(controller.select).toHaveBeenLastCalledWith([]);
  });

  it('the arrow keys move the focus and select the row', () => {
    const controller = fakeController([mark(0, 'a'), mark(0, 'b')]);
    render(controller);
    key(rows()[0] as HTMLElement, 'ArrowDown');
    expect(controller.select).toHaveBeenLastCalledWith([{ page: 0, name: 'b' }]);
  });
});

describe('SelectedMarkOutlines', () => {
  it('outlines each selected box on the page', () => {
    act(() => {
      root.render(
        <SelectedMarkOutlines
          zoom={1}
          rects={[
            { x0: 0, y0: 0, x1: 10, y1: 10 },
            { x0: 20, y0: 20, x1: 30, y1: 30 },
          ]}
        />,
      );
    });
    expect(container.querySelectorAll('.redact-selected')).toHaveLength(2);
  });
});
