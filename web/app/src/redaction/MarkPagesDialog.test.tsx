import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t, tp } from '../i18n/t';
import type { PageArea } from '../text/textLayer';
import { MarkPagesDialog } from './MarkPagesDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const PAGES = [
  { width: 612, height: 792, rotation: 0 },
  { width: 612, height: 792, rotation: 0 },
  { width: 792, height: 612, rotation: 90 },
];

let host: HTMLDivElement;
let root: Root;

function fakeRpc() {
  const call = vi.fn((method: string) =>
    method === 'session.pages'
      ? Promise.resolve({ pages: PAGES, labels: [] })
      : new Promise(() => undefined),
  );
  return { call, rpc: { call } as unknown as Pick<PageRpc, 'call'> as PageRpc };
}

function fakeController() {
  return {
    getSnapshot: () => ({ busy: false }),
    markAreas: vi.fn<(areas: readonly PageArea[]) => Promise<number>>(async () => 1),
  };
}

function render(controller: ReturnType<typeof fakeController>, rpc: PageRpc, onClose = vi.fn()) {
  act(() => {
    root.render(
      <MarkPagesDialog
        isOpen
        onClose={onClose}
        controller={controller}
        rpc={rpc}
        handle="doc-1"
        pageCount={3}
        currentPage={2}
      />,
    );
  });
  return { onClose };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === label,
  );
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

function radio(value: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
  if (found === null) throw new Error(`no ${value} option`);
  return found;
}

function choose(input: HTMLInputElement): void {
  act(() => {
    input.click();
  });
}

function typeRange(text: string): void {
  const input = document.querySelector<HTMLInputElement>('.mark-pages-range');
  if (input === null) throw new Error('no range field');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function alertText(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MarkPagesDialog', () => {
  it('marks the current page by default, with its own box', async () => {
    const { rpc } = fakeRpc();
    const controller = fakeController();
    const onClose = vi.fn();
    render(controller, rpc, onClose);
    await settle();
    expect(document.body.textContent).not.toContain(tp('markPages.confirm', 1));
    act(() => {
      button(t('markPages.apply')).click();
    });
    await settle();
    const areas = controller.markAreas.mock.calls[0]?.[0];
    expect(areas).toEqual([
      { page: 1, rect: { x0: 0, y0: 0, x1: 612, y1: 792 }, quads: [], text: '' },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('marks all pages after a confirmation line, and rotated pages keep their own box', async () => {
    const { rpc } = fakeRpc();
    const controller = fakeController();
    render(controller, rpc);
    await settle();
    choose(radio('all'));
    expect(document.body.textContent).toContain(tp('markPages.confirm', 3));
    act(() => {
      button(t('markPages.apply')).click();
    });
    await settle();
    const areas = controller.markAreas.mock.calls[0]?.[0] ?? [];
    expect(areas.map((area) => area.rect.x1)).toEqual([612, 612, 792]);
  });

  it('refuses a bad range inside the dialog and sends nothing', async () => {
    const { rpc } = fakeRpc();
    const controller = fakeController();
    const onClose = vi.fn();
    render(controller, rpc, onClose);
    await settle();
    choose(radio('range'));
    typeRange('1-9');
    act(() => {
      button(t('markPages.apply')).click();
    });
    await settle();
    expect(alertText()).toBe(t('markPages.error.range'));
    expect(controller.markAreas).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel closes without marking', async () => {
    const { rpc } = fakeRpc();
    const controller = fakeController();
    const onClose = vi.fn();
    render(controller, rpc, onClose);
    await settle();
    act(() => {
      button(t('markPages.cancel')).click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(controller.markAreas).not.toHaveBeenCalled();
  });
});
