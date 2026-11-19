import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { t } from '../i18n/t';
import { type PrintRpc } from './printJob';
import { PrintDialog } from './PrintDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') },
  });
}

let host: HTMLDivElement;
let root: Root;

function workerThatNeverAnswers(): WorkerClient {
  return {
    call: vi.fn(() => new Promise<CallResult>(() => undefined)),
    onStage: vi.fn(() => () => undefined),
    terminate: vi.fn(),
  };
}

function rpcStub() {
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
    () => new Promise(() => undefined),
  );
  return { call, rpc: { call: call as unknown as PrintRpc['call'] } };
}

function render(pageCount: number, rpc: PrintRpc | null, startWorker = workerThatNeverAnswers) {
  const onClose = vi.fn();
  act(() => {
    root.render(
      <PrintDialog
        isOpen
        onClose={onClose}
        session={rpc === null ? null : { rpc, handle: 'h1' }}
        pageCount={pageCount}
        currentPage={2}
        startWorker={startWorker}
      />,
    );
  });
  return { onClose };
}

function radio(value: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `input[name="print-scope"][value="${value}"]`,
  );
  if (found === null) throw new Error(`no ${value} radio`);
  return found;
}

function typeText(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function printButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === t('print.start'),
  );
  if (found === undefined) throw new Error('no Print button');
  return found;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
});

describe('PrintDialog', () => {
  it('refuses an invalid range before any job starts and shows the message', () => {
    const { call, rpc } = rpcStub();
    const { onClose } = render(6, rpc);
    act(() => {
      radio('range').click();
    });
    typeText(document.querySelector<HTMLInputElement>('.print-range')!, '1-9');
    act(() => {
      printButton().click();
    });
    expect(call).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t('print.range.invalid'));
  });

  it('starts print_pages for the typed range at the chosen dpi and closes the dialog', async () => {
    const { call, rpc } = rpcStub();
    const { onClose } = render(6, rpc);
    act(() => {
      radio('range').click();
    });
    typeText(document.querySelector<HTMLInputElement>('.print-range')!, '1-3, 5');
    const dpi = document.querySelector<HTMLSelectElement>('select')!;
    act(() => {
      dpi.value = '300';
      dpi.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => {
      printButton().click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]).toEqual([
      'jobs.prepare',
      {
        handle: 'h1',
        job: 'print_pages',
        args: { pages: [0, 1, 2, 4], dpi: 300, annotations: true },
      },
    ]);
  });

  it('uses the current page for the current-page scope', async () => {
    const { call, rpc } = rpcStub();
    render(6, rpc);
    act(() => {
      radio('current').click();
    });
    act(() => {
      printButton().click();
    });
    await vi.waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[1]).toMatchObject({ args: { pages: [1], dpi: 150 } });
  });

  it('has no Print action without a document', () => {
    render(0, null);
    expect(printButton().disabled).toBe(true);
  });

  it('warns above 200 pages', () => {
    render(250, rpcStub().rpc);
    expect(document.body.textContent).toContain(t('print.large', { count: 250 }));
  });
});
