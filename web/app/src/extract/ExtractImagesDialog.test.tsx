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
});
