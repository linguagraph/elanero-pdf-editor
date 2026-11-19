import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { t } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { CommentsExportDialog, type CommentsExportDialogProps } from './CommentsExportDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape: (value: string) => value.replace(/[^\w-]/g, (char) => String.fromCharCode(92) + char),
    },
  });
}

const BYTES = new Uint8Array([60, 120, 102, 100, 102]).buffer;

// The job worker's reply to job.run: a file job returns its file as the one binary value.
function fileWorker(name: string, mime: string): JobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: { kind: 'files', files: [{ name, mime, data: { $bin: 0 } }], value: null },
    events: [],
  };
  return {
    call: vi.fn(async () => ({ reply: JSON.stringify(reply), buffer: BYTES.slice(0) })),
    terminate: vi.fn(),
  };
}

// A job worker whose job failed with the given error code.
function failingWorker(code: string, message: string): JobWorker {
  const reply = { v: PROTOCOL_VERSION, id: 1, ok: false, error: { code, message }, events: [] };
  return {
    call: vi.fn(async () => ({ reply: JSON.stringify(reply) })),
    terminate: vi.fn(),
  };
}

// A fake engine: each method answers from the table, and every call is recorded.
function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'comments.export',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: true, state: {} };
  });
  return { call };
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function radio(value: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
  if (found === null) throw new Error(`no radio ${value}`);
  return found;
}

function setup(worker: JobWorker, overrides: Partial<CommentsExportDialogProps> = {}) {
  const { call } = fakeEngine();
  const store: ToastStore = createToastStore();
  const progress: JobProgressStore = createJobProgressStore({ toasts: store });
  const onClose = vi.fn();
  const download = vi.fn();
  const props: CommentsExportDialogProps = {
    isOpen: true,
    onClose,
    engine: { call } as unknown as FileJobEngine,
    handle: 'h1',
    name: 'Report.pdf',
    startWorker: () => worker,
    progress,
    store,
    download,
    ...overrides,
  };
  act(() => root.render(<CommentsExportDialog {...props} />));
  return { call, store, onClose, download };
}

describe('CommentsExportDialog', () => {
  it('offers the three formats with XFDF selected by default', async () => {
    setup(fileWorker('Report.xfdf', 'application/xml'));
    await settle();
    expect(radio('xfdf').checked).toBe(true);
    expect(radio('csv').checked).toBe(false);
    expect(radio('pdf').checked).toBe(false);
    expect(document.body.textContent).toContain(
      t('commentsExport.fileName', { file: 'Report.xfdf' }),
    );
  });

  it('runs the comments_export job for the chosen format and downloads the file', async () => {
    const { call, onClose, download, store } = setup(fileWorker('Report-comments.csv', 'text/csv'));
    await settle();
    await act(async () => {
      radio('csv').click();
    });
    await act(async () => {
      buttonNamed(t('commentsExport.export')).click();
    });
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith(
      'jobs.prepare',
      expect.objectContaining({
        handle: 'h1',
        job: 'comments_export',
        args: { format: 'csv', name: 'Report.pdf' },
      }),
    );
    expect(download).toHaveBeenCalledWith(
      'Report-comments.csv',
      expect.any(ArrayBuffer),
      'text/csv',
    );
    expect(store.getState().visible.map((toast) => toast.text)).toContain(t('commentsExport.done'));
  });

  it('says the PDF summary is unavailable when the engine cannot lay it out', async () => {
    const { store, download } = setup(failingWorker('NOT_SUPPORTED', 'no layout engine'));
    await settle();
    await act(async () => {
      radio('pdf').click();
    });
    await act(async () => {
      buttonNamed(t('commentsExport.export')).click();
    });
    await settle();
    expect(download).not.toHaveBeenCalled();
    expect(store.getState().visible.map((toast) => toast.text)).toContain(
      t('commentsExport.pdfUnavailable'),
    );
  });

  it('reports other failures through the shared error reporter', async () => {
    const { store } = setup(failingWorker('ENGINE_ERROR', 'boom'));
    await settle();
    await act(async () => {
      buttonNamed(t('commentsExport.export')).click();
    });
    await settle();
    expect(store.getState().visible.map((toast) => toast.text)).not.toContain(
      t('commentsExport.done'),
    );
    expect(store.getState().visible.length).toBeGreaterThan(0);
  });

  it('Cancel closes without running a job', async () => {
    const worker = fileWorker('x', 'text/csv');
    const { call, onClose } = setup(worker);
    await settle();
    await act(async () => {
      buttonNamed(t('commentsExport.cancel')).click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(worker.call).not.toHaveBeenCalled();
  });
});
