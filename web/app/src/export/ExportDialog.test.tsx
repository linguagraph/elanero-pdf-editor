import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { ExportDialog, type ExportDialogProps } from './ExportDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const BYTES = new Uint8Array([137, 80, 78, 71]).buffer;

// A job reply with one file, as the export job writes it (kind "files", one $bin buffer).
function fileReply(name: string, mime: string): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [{ name, mime, data: { $bin: 0 } }],
      value: null,
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply), buffer: BYTES };
}

function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'export',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as FileJobEngine };
}

function fakeWorker(reply: Promise<CallResult> | CallResult): JobWorker {
  return {
    call: vi.fn(() => Promise.resolve(reply)),
    terminate: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => 'blob:export-test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// The dialog renders in a portal on the body, so queries go to the document.
function dialogElement(): HTMLElement {
  return document.body;
}

function render(
  props: Partial<ExportDialogProps> & { progress: JobProgressStore; engine: FileJobEngine },
) {
  const full: ExportDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    pageCount: 10,
    currentPage: 4,
    startWorker: () => fakeWorker(fileReply('export.png', 'image/png')),
    ...props,
  };
  act(() => root.render(<ExportDialog {...full} />));
  return full;
}

function findButton(label: string): HTMLButtonElement {
  const button = [...dialogElement().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button ${label}`);
  return button;
}

function choose(label: string) {
  const radio = [...dialogElement().querySelectorAll('input[type="radio"]')].find(
    (candidate) => candidate.closest('label')?.textContent === label,
  ) as HTMLInputElement | undefined;
  if (radio === undefined) throw new Error(`no option ${label}`);
  act(() => radio.click());
}

function typeInto(selector: string, value: string) {
  const input = dialogElement().querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`no input ${selector}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function submit() {
  act(() => findButton(t('export.submit')).click());
}

describe('ExportDialog', () => {
  it('refuses an empty page range before any job starts', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    choose(t('export.pages.range'));

    submit();
    await flush();

    expect(dialogElement().textContent).toContain(t('split.error.ranges.empty'));
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a range outside the document before any job starts', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    choose(t('export.pages.range'));
    typeInto('input[type="text"]', '9-12');

    submit();
    await flush();

    expect(dialogElement().textContent).toContain(
      t('split.error.ranges.outOfRange', { item: '9-12', count: 10 }),
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('runs the export job with the format, pages and dpi, then offers the file', async () => {
    const { call, engine } = fakeEngine();
    const worker = fakeWorker(fileReply('export.png', 'image/png'));
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => worker });
    choose(t('export.format.png'));
    choose(t('export.pages.range'));
    typeInto('input[type="text"]', '1-2');
    choose(t('export.dpi.option', { dpi: 300 }));

    submit();
    await flush();

    expect(
      call.mock.calls.map((entry) => entry[0]).filter((name) => name !== 'system.memory'),
    ).toEqual(['jobs.prepare', 'jobs.apply']);
    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'export',
      args: { format: 'png', pages: [0, 1], dpi: 300, annotations: true },
    });
    expect(worker.call).toHaveBeenCalledTimes(1);
    const link = dialogElement().querySelector<HTMLAnchorElement>('a.export-download');
    expect(link?.textContent).toBe(t('export.download', { name: 'export.png' }));
    expect(link?.getAttribute('download')).toBe('export.png');
    expect(link?.getAttribute('href')).toBe('blob:export-test');
  });

  it('exports the current page as the page the viewer shows', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, currentPage: 4 });
    choose(t('export.format.md'));
    choose(t('export.pages.current'));

    submit();
    await flush();

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({ job: 'export', args: { format: 'md', pages: [3] } });
  });

  it('offers a ZIP for several page images and says so', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () => fakeWorker(fileReply('export.zip', 'application/zip')),
    });
    choose(t('export.format.jpeg'));

    submit();
    await flush();

    const link = dialogElement().querySelector<HTMLAnchorElement>('a.export-download');
    expect(link?.getAttribute('download')).toBe('export.zip');
    expect(dialogElement().textContent).toContain(t('export.archive.hint'));
  });

  it('shows the running state and the job bar while the export runs', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    let finish: (result: CallResult) => void = () => undefined;
    const pending = new Promise<CallResult>((resolve) => {
      finish = resolve;
    });
    render({ engine, progress, startWorker: () => fakeWorker(pending) });

    submit();
    await flush();

    expect(dialogElement().textContent).toContain(t('export.running'));
    expect(progress.getState().job?.token).toBe('j1');

    await act(async () => {
      finish(fileReply('export.txt', 'text/plain'));
      await Promise.resolve();
    });
    await flush();
    expect(dialogElement().textContent).not.toContain(t('export.running'));
  });

  it('calls jobs.abort when the job bar cancels, and reports no error', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const pending = new Promise<CallResult>(() => undefined);
    render({ engine, progress, startWorker: () => fakeWorker(pending) });

    submit();
    await flush();
    await act(async () => {
      await progress.cancel();
    });
    await flush();

    expect(call.mock.calls.map((entry) => entry[0])).toContain('jobs.abort');
    expect(progress.getState().job).toBeUndefined();
    expect(dialogElement().textContent).not.toContain(t('export.failed'));
  });
});
