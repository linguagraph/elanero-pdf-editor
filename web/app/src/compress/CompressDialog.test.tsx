import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { t } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { CompressDialog, type CompressDialogProps, formatSize } from './CompressDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

// A job reply for reduce_size: one reduced.pdf and the sizes the job reports (ReduceSizeValue).
function reduceReply(before: number, after: number): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [{ name: 'reduced.pdf', mime: 'application/pdf', data: { $bin: 0 } }],
      value: { before, after, notes: [] },
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply), buffer: BYTES };
}

function errorReply(): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: false,
    error: { code: 'INTERNAL', message: 'boom' },
    events: [],
  };
  return { reply: JSON.stringify(reply) };
}

function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'Reduce File Size',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as FileJobEngine };
}

// A worker whose reply the test decides: pending until resolved.
function deferredWorker() {
  let resolve: (value: CallResult) => void = () => undefined;
  const reply = new Promise<CallResult>((done) => {
    resolve = done;
  });
  const worker: JobWorker = {
    call: vi.fn(() => reply),
    terminate: vi.fn(),
  };
  return { worker, finish: (value: CallResult) => resolve(value) };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => 'blob:compress-test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function render(
  props: Partial<CompressDialogProps> & { progress: JobProgressStore; engine: FileJobEngine },
) {
  const full: CompressDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    startWorker: () => deferredWorker().worker,
    ...props,
  };
  act(() => root.render(<CompressDialog {...full} />));
  return full;
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button ${label}`);
  return button;
}

function choose(label: string) {
  const radio = [...document.body.querySelectorAll('input[type="radio"]')].find(
    (candidate) => candidate.closest('label')?.textContent === label,
  ) as HTMLInputElement | undefined;
  if (radio === undefined) throw new Error(`no option ${label}`);
  act(() => radio.click());
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function submit() {
  act(() => findButton(t('compress.submit')).click());
}

describe('CompressDialog', () => {
  it('runs reduce_size with the chosen preset and shows progress', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });
    choose(t('compress.preset.print'));

    submit();
    await flush();

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'reduce_size',
      args: { preset: 'print' },
    });
    expect(job.worker.call).toHaveBeenCalledTimes(1);

    act(() => progress.progress('j1', 40));
    const bar = document.body.querySelector<HTMLProgressElement>('progress.compress-progress');
    expect(bar?.value).toBe(40);
    expect(document.body.textContent).toContain(t('compress.running'));

    await act(async () => job.finish(reduceReply(2_000_000, 500_000)));
    await flush();
  });

  it('shows both sizes and the download of the reduced file', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    submit();
    await flush();
    await act(async () => job.finish(reduceReply(2_000_000, 500_000)));
    await flush();

    expect(document.body.textContent).toContain(
      t('compress.result.sizes', { before: '1.9 MB', after: '488.3 KB', percent: 75 }),
    );
    const link = document.body.querySelector<HTMLAnchorElement>('a.compress-download');
    expect(link?.textContent).toBe(t('compress.download', { name: 'reduced.pdf' }));
    expect(link?.getAttribute('download')).toBe('reduced.pdf');
    expect(link?.getAttribute('href')).toBe('blob:compress-test');
    expect(document.body.textContent).not.toContain(
      t('compress.notSmaller', { before: '1.9 MB', after: '488.3 KB' }),
    );
  });

  it('says so and offers no download when the copy is not smaller', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const onClose = vi.fn();
    render({ engine, progress, onClose, startWorker: () => job.worker });

    submit();
    await flush();
    await act(async () => job.finish(reduceReply(1000, 1200)));
    await flush();

    expect(document.body.textContent).toContain(
      t('compress.notSmaller', { before: '1000 bytes', after: '1.2 KB' }),
    );
    expect(document.body.querySelector('a.compress-download')).toBeNull();
    expect(document.body.textContent).not.toContain(
      t('compress.result.sizes', { before: '1000 bytes', after: '1.2 KB', percent: 0 }),
    );

    act(() => findButton(t('compress.keep')).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels through the job flow: jobs.abort and the worker is stopped', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    submit();
    await flush();
    act(() => findButton(t('compress.cancel')).click());
    await flush();

    expect(call.mock.calls.map((entry) => entry[0])).toContain('jobs.abort');
    expect(job.worker.terminate).toHaveBeenCalled();
    expect(progress.getState().job).toBeUndefined();
    expect(document.body.textContent).not.toContain(t('compress.failed'));
    expect(findButton(t('compress.submit')).disabled).toBe(false);
  });

  it('reports a failed reduce with a message and keeps the dialog usable', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    submit();
    await flush();
    await act(async () => job.finish(errorReply()));
    await flush();

    expect(document.body.textContent).toContain(t('compress.failed'));
    expect(document.body.querySelector('a.compress-download')).toBeNull();
  });
});

describe('formatSize', () => {
  it('uses bytes, then KB, MB and GB to one decimal place', () => {
    expect(formatSize(512)).toBe(t('compress.size.bytes', { count: 512 }));
    expect(formatSize(2048)).toBe(t('compress.size.kb', { value: '2.0' }));
    expect(formatSize(3 * 1024 * 1024)).toBe(t('compress.size.mb', { value: '3.0' }));
    expect(formatSize(5 * 1024 ** 3)).toBe(t('compress.size.gb', { value: '5.0' }));
  });
});
