import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { createToastStore } from '../feedback/toasts';
import { t, tp } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { ExtractImagesDialog, type ExtractImagesDialogProps } from './ExtractImagesDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const BYTES = new Uint8Array([137, 80, 78, 71]).buffer;

// A job reply as extract_images writes it: kind "files" with its value, one $bin buffer per file.
function imagesReply(files: readonly string[], count: number, tooLarge: number): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: files.map((name, index) => ({
        name,
        mime: name.endsWith('.zip') ? 'application/zip' : 'image/png',
        data: { $bin: index },
      })),
      value: { count, too_large: tooLarge },
      name: '',
    },
    events: [],
  };
  return {
    reply: JSON.stringify(reply),
    buffer: BYTES,
    buffers: files.map(() => BYTES),
  } as CallResult;
}

function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'extract_images',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as FileJobEngine };
}

function fakeWorker(reply: CallResult): JobWorker {
  return { call: vi.fn(() => Promise.resolve(reply)), terminate: vi.fn() };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => 'blob:extract-test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function render(
  props: Partial<ExtractImagesDialogProps> & { progress: JobProgressStore; engine: FileJobEngine },
) {
  const full: ExtractImagesDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    name: 'Report.pdf',
    pageCount: 10,
    currentPage: 4,
    startWorker: () => fakeWorker(imagesReply(['page1-image1.png'], 1, 0)),
    ...props,
  };
  act(() => root.render(<ExtractImagesDialog {...full} />));
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button ${label}`);
  return button;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ExtractImagesDialog', () => {
  it('runs extract_images with the document name and every page, then offers the image', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });

    act(() => findButton(t('extract.submit')).click());
    await flush();

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'extract_images',
      args: { name: 'Report.pdf', pages: null },
    });
    const link = document.body.querySelector<HTMLAnchorElement>('a.export-download');
    expect(link?.textContent).toBe(t('export.download', { name: 'page1-image1.png' }));
    expect(document.body.textContent).toContain(tp('extract.images.saved', 1));
  });

  it('says so when no image was found, and offers no file', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => fakeWorker(imagesReply([], 0, 0)) });

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(document.body.textContent).toContain(t('extract.images.none'));
    expect(document.body.querySelector('a.export-download')).toBeNull();
  });

  it('names the images skipped for their size', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () => fakeWorker(imagesReply(['a-images.zip'], 2, 2)),
    });

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(document.body.textContent).toContain(tp('extract.images.tooLarge', 2));
    expect(document.body.textContent).toContain(t('export.archive.hint'));
  });

  it('refuses an empty range before any job starts', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    const radio = [...document.body.querySelectorAll('input[type="radio"]')].find(
      (candidate) => candidate.closest('label')?.textContent === t('export.pages.range'),
    ) as HTMLInputElement;
    act(() => radio.click());

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(call).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  // The job arguments of the first prepare call.
  function prepareArgs(call: { mock: { calls: unknown[][] } }): unknown {
    const request = call.mock.calls[0]?.[1];
    return request;
  }

  function chooseRadio(label: string) {
    const radio = [...document.body.querySelectorAll('input[type="radio"]')].find(
      (candidate) => candidate.closest('label')?.textContent === label,
    ) as HTMLInputElement;
    act(() => radio.click());
  }

  function typeRange(value: string) {
    const input = document.body.querySelector<HTMLInputElement>('.export input[type="text"]');
    if (input === null) throw new Error('no range input');
    // React tracks the value itself, so the native setter is what makes the change visible to it.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('the current-page choice runs the job on the viewer page, 0-based', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, currentPage: 4 });
    chooseRadio(t('export.pages.current'));

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(prepareArgs(call)).toMatchObject({ args: { pages: [3] } });
  });

  it('a page range runs the job on those pages, 0-based, in the order typed', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    chooseRadio(t('export.pages.range'));
    typeRange('2-3');

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(prepareArgs(call)).toMatchObject({ args: { pages: [1, 2] } });
  });

  it('closing the dialog during a run cancels the job, and Close is disabled while it runs', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const terminate = vi.fn();
    const worker: JobWorker = {
      call: vi.fn(() => new Promise<CallResult>(() => undefined)),
      terminate,
    };
    const onClose = vi.fn();
    render({ engine, progress, onClose, startWorker: () => worker });

    act(() => findButton(t('extract.submit')).click());
    await flush();
    expect(findButton(t('extract.close')).disabled).toBe(true);
    expect(progress.getState().job).toBeDefined();

    render({ engine, progress, onClose, startWorker: () => worker, isOpen: false });
    await flush();

    expect(call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(terminate).toHaveBeenCalled();
    expect(progress.getState().job).toBeUndefined();
  });

  it('closing the dialog while prepare is in flight stops the run before it begins', async () => {
    // prepare returns only when the test lets it, so the dialog closes before any job is on the bar.
    let finishPrepare: (value: unknown) => void = () => undefined;
    const call = vi.fn((method: string): Promise<unknown> => {
      if (method === 'jobs.prepare') {
        return new Promise<unknown>((resolve) => {
          finishPrepare = (value) => resolve(value);
        });
      }
      return Promise.resolve({ applied: false, changed: null, state: null });
    });
    const engine = { call } as unknown as FileJobEngine;
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const beginSpy = vi.spyOn(progress, 'begin');
    const worker = fakeWorker(imagesReply(['page1-image1.png'], 1, 0));
    const startWorker = vi.fn(() => worker);
    render({ engine, progress, startWorker });

    act(() => findButton(t('extract.submit')).click());
    await flush();
    render({ engine, progress, startWorker, isOpen: false });
    await flush();

    finishPrepare({
      token: 'j1',
      label: 'extract_images',
      mutating: false,
      document: BYTES.slice(0),
      state: null,
    });
    await flush();

    expect(beginSpy).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
    expect(worker.call).not.toHaveBeenCalled();
    expect(progress.getState().job).toBeUndefined();
    expect(call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
  });

  it('closing the dialog does not cancel a job on the bar that this dialog did not start', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });

    // The dialog's run finishes, then another feature starts a job before the form unmounts.
    act(() => findButton(t('extract.submit')).click());
    await flush();
    const otherClient = { call: vi.fn(() => Promise.resolve({})) };
    expect(
      progress.begin({
        handle: 'doc-1',
        token: 'ocr-9',
        label: 'OCR',
        client: otherClient,
      }),
    ).toBe(true);

    render({ engine, progress, isOpen: false });
    await flush();

    expect(otherClient.call).not.toHaveBeenCalled();
    expect(progress.getState().job?.token).toBe('ocr-9');
  });

  it('a failed job shows the failure message', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const worker: JobWorker = {
      call: vi.fn(() => Promise.reject(new Error('boom'))),
      terminate: vi.fn(),
    };
    render({ engine, progress, startWorker: () => worker });

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(t('extract.failed'));
  });

  it('a refused job (BUSY) shows the reason the catalogue gives for it', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    // Another job holds the bar, so this one is refused when it starts.
    progress.begin({ handle: 'doc-1', token: 'other', label: 'OCR' });
    render({ engine, progress });

    act(() => findButton(t('extract.submit')).click());
    await flush();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(t('error.BUSY'));
  });
});
