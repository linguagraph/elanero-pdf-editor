import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { CombineDialog } from './CombineDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// A job worker that answers every job.run with a merged document.
function mergingWorker(output: ArrayBuffer): WorkerClient {
  return {
    call: (): Promise<CallResult> =>
      Promise.resolve({
        reply: JSON.stringify({
          v: 1,
          id: 1,
          ok: true,
          result: {
            kind: 'new_document',
            label: '',
            require_full_save: false,
            document: { $bin: 0 },
            files: [],
            value: null,
            name: 'merged.pdf',
          },
          events: [],
        }),
        buffer: output,
      }),
    onStage: () => () => undefined,
    terminate: vi.fn(),
  };
}

let host: HTMLDivElement;
let root: Root;

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

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  return input;
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

// Picks files through the hidden file input, as the browser does after the user chooses them.
function pick(...names: string[]): void {
  const input = fileInput();
  const files = names.map((name) => new File(['pdf'], name, { type: 'application/pdf' }));
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function rowNames(): string[] {
  return [...document.querySelectorAll('.combine-row .combine-name')].map(
    (node) => node.textContent ?? '',
  );
}

function render(props: {
  startWorker?: () => WorkerClient;
  download?: (name: string, bytes: ArrayBuffer) => void;
}) {
  const store = createJobProgressStore({ toasts: createToastStore() });
  act(() => {
    root.render(
      <CombineDialog
        isOpen
        onClose={() => undefined}
        store={store}
        startWorker={props.startWorker ?? (() => mergingWorker(new ArrayBuffer(0)))}
        download={props.download ?? (() => undefined)}
      />,
    );
  });
  return store;
}

describe('CombineDialog', () => {
  it('lists the added sources in order and moves, removes and renames nothing else', () => {
    render({});

    pick('a.pdf', 'b.png', 'c.pdf');
    expect(rowNames()).toEqual(['a.pdf', 'b.png', 'c.pdf']);

    act(() => {
      buttonNamed(t('combine.moveUp')).click(); // the first row is at the top: no change
    });
    const moveDown = [...document.querySelectorAll<HTMLButtonElement>('.combine-row')][1];
    act(() => {
      moveDown?.querySelectorAll('button')[1]?.click(); // b.png moves down past c.pdf
    });
    expect(rowNames()).toEqual(['a.pdf', 'c.pdf', 'b.png']);

    const firstRow = document.querySelector('.combine-row');
    act(() => {
      firstRow?.querySelectorAll('button')[2]?.click(); // remove a.pdf
    });
    expect(rowNames()).toEqual(['c.pdf', 'b.png']);
  });

  it('says which dropped or picked files were not PDFs or images and adds the rest', () => {
    render({});

    pick('notes.txt', 'a.pdf');

    expect(rowNames()).toEqual(['a.pdf']);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      t('combine.unsupported', { name: 'notes.txt' }),
    );
  });

  it('refuses fewer than two sources with a message and starts no job', async () => {
    const startWorker = vi.fn(() => mergingWorker(new ArrayBuffer(0)));
    render({ startWorker });
    pick('a.pdf');

    await act(async () => {
      buttonNamed(t('combine.button')).click();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t('combine.needTwo'));
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('combines the sources in order and offers the result as a download', async () => {
    const output = new Uint8Array([1, 2, 3]).buffer;
    const download = vi.fn();
    const store = render({ startWorker: () => mergingWorker(output), download });
    pick('a.pdf', 'b.pdf');

    await act(async () => {
      buttonNamed(t('combine.button')).click();
    });

    expect(store.getState().job).toBeUndefined();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(t('combine.done'));
    await act(async () => {
      buttonNamed(t('combine.download', { name: 'merged.pdf' })).click();
    });
    expect(download).toHaveBeenCalledWith('merged.pdf', output);
  });

  it('uses the output name the user typed for the download', async () => {
    const output = new Uint8Array([4]).buffer;
    const download = vi.fn();
    render({ startWorker: () => mergingWorker(output), download });
    pick('a.pdf', 'b.pdf');
    const name = document.querySelector<HTMLInputElement>('.combine-output input');
    act(() => {
      if (name !== null) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(name, 'report');
        name.dispatchEvent(new Event('input', { bubbles: true }));
        name.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    await act(async () => {
      buttonNamed(t('combine.button')).click();
    });
    await act(async () => {
      buttonNamed(t('combine.download', { name: 'report.pdf' })).click();
    });

    expect(download).toHaveBeenCalledWith('report.pdf', output);
  });
});
