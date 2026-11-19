import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { MAX_FILE_BYTES } from '../documents/openFile';
import { PROTOCOL_VERSION } from '../rpc/generated';
import type { JobWorker, SplitEngine } from '../split/splitJob';
import { CompareDialog, type CompareDialogProps } from './CompareDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const OLD_BYTES = new Uint8Array([37, 80, 68, 70, 1]).buffer;
const NEW_NAME = 'Second.pdf';
const NEW_CONTENT = 'second document';

// The report the job worker returns for a changed first page, and an inserted second page.
function reportReply(): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'report',
      label: '',
      require_full_save: false,
      document: null,
      files: [],
      value: {
        identical: false,
        pairs: [
          [0, 0],
          [1, 1],
          [2, null],
        ],
        changes: [
          { kind: 'replaced', page_a: 0, page_b: 0, summary: "'Total' -> 'Sum'" },
          { kind: 'page inserted', page_a: null, page_b: 2, summary: 'page 3 added' },
        ],
      },
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply) };
}

function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'compare',
        mutating: false,
        document: OLD_BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as SplitEngine };
}

function fakeWorker(reply: Promise<CallResult> | CallResult = reportReply()): JobWorker & {
  call: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(() => Promise.resolve(reply)),
    terminate: vi.fn(),
  } as unknown as JobWorker & { call: ReturnType<typeof vi.fn> };
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
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// The dialog renders in a portal on the body, so queries go to the document.
function dialogElement(): HTMLElement {
  return document.body;
}

function render(
  props: Partial<CompareDialogProps> & { progress: JobProgressStore; engine: SplitEngine },
) {
  const full: CompareDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    currentName: 'First.pdf',
    startWorker: () => fakeWorker(),
    onGoToPage: vi.fn(),
    ...props,
  };
  act(() => root.render(<CompareDialog {...full} />));
  return full;
}

function findButton(label: string): HTMLButtonElement {
  const button = [...dialogElement().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button ${label}`);
  return button;
}

// Picks the newer document through the hidden file input, as the browser does.
function pickFile(file: File) {
  const input = dialogElement().querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function newerFile(): File {
  return new File([NEW_CONTENT], NEW_NAME, { type: 'application/pdf' });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CompareDialog', () => {
  it('asks for the newer document before anything starts', async () => {
    const { call, engine } = fakeEngine();
    render({ engine, progress: createJobProgressStore({ toasts: createToastStore() }) });

    act(() => findButton(t('compare.submit')).click());
    await flush();

    expect(dialogElement().textContent).toContain(t('compare.error.noFile'));
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a file over the 1 GiB limit before any job starts', async () => {
    const { call, engine } = fakeEngine();
    render({ engine, progress: createJobProgressStore({ toasts: createToastStore() }) });
    const big = newerFile();
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });

    pickFile(big);
    act(() => findButton(t('compare.submit')).click());
    await flush();

    expect(dialogElement().textContent).toContain(t('compare.error.tooLarge'));
    expect(call).not.toHaveBeenCalled();
  });

  it('sends the newer document bytes and the job arguments, then shows the report', async () => {
    const { call, engine } = fakeEngine();
    const worker = fakeWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => worker });
    pickFile(newerFile());

    act(() => findButton(t('compare.submit')).click());
    await flush();

    expect(
      call.mock.calls.map((entry) => entry[0]).filter((name) => name !== 'system.memory'),
    ).toEqual(['jobs.prepare', 'jobs.apply']);
    const prepare = call.mock.calls[0] as unknown as [string, { args: { other: unknown } }];
    expect(prepare[1]).toMatchObject({
      handle: 'doc-1',
      job: 'compare',
      args: { text: true, visual: true },
    });
    expect(prepare[1].args.other).toBeInstanceOf(ArrayBuffer);
    const [request, buffers] = worker.call.mock.calls[0] as unknown as [string, ArrayBuffer[]];
    expect(JSON.parse(request).params.args).toMatchObject({ other: { $bin: 1 } });
    expect(new TextDecoder().decode(buffers[1])).toBe(NEW_CONTENT);
    expect(dialogElement().textContent).toContain(
      t('compare.report.summary', { compared: 3, changed: 2 }),
    );
  });

  it('shows the job on the progress bar while it runs', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () => fakeWorker(new Promise<CallResult>(() => undefined)),
    });
    pickFile(newerFile());

    act(() => findButton(t('compare.submit')).click());
    await flush();

    expect(progress.getState().job?.label).toBe('compare');
    expect(dialogElement().textContent).toContain(t('compare.running'));
  });

  it('renders the changed pages and their changes from the report', async () => {
    const { engine } = fakeEngine();
    render({
      engine,
      progress: createJobProgressStore({ toasts: createToastStore() }),
    });
    pickFile(newerFile());

    act(() => findButton(t('compare.submit')).click());
    await flush();

    const pages = dialogElement().querySelectorAll('.compare-page');
    expect(pages).toHaveLength(2);
    expect(pages[0]?.textContent).toContain(t('compare.report.page', { page: 1 }));
    expect(pages[0]?.textContent).toContain(`${t('compare.kind.replaced')}: 'Total' -> 'Sum'`);
    expect(pages[1]?.textContent).toContain(t('compare.report.pageNewOnly', { page: 3 }));
    expect(pages[1]?.textContent).toContain(t('compare.kind.pageInserted'));
  });

  it('a changed-page link scrolls the open view to that page and closes', async () => {
    const { engine } = fakeEngine();
    const onGoToPage = vi.fn();
    const onClose = vi.fn();
    render({
      engine,
      onGoToPage,
      onClose,
      progress: createJobProgressStore({ toasts: createToastStore() }),
    });
    pickFile(newerFile());
    act(() => findButton(t('compare.submit')).click());
    await flush();

    act(() => findButton(t('compare.report.page', { page: 1 })).click());

    expect(onGoToPage).toHaveBeenCalledWith(0);
    expect(onClose).toHaveBeenCalled();
  });

  it('saves the report as a text file with the report text', async () => {
    const { engine } = fakeEngine();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:compare-test';
    });
    URL.revokeObjectURL = vi.fn();
    // jsdom cannot follow a blob link; the click only needs to start the download.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render({
      engine,
      progress: createJobProgressStore({ toasts: createToastStore() }),
    });
    pickFile(newerFile());
    act(() => findButton(t('compare.submit')).click());
    await flush();

    act(() => findButton(t('compare.report.save')).click());

    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('text/plain');
    const body = await blobs[0]?.text();
    expect(body).toContain(t('compare.report.title'));
    expect(body).toContain(`${t('compare.kind.replaced')}: 'Total' -> 'Sum'`);
  });

  it('cancel from the progress bar aborts the job and shows no error', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () => fakeWorker(new Promise<CallResult>(() => undefined)),
    });
    pickFile(newerFile());
    act(() => findButton(t('compare.submit')).click());
    await flush();

    await act(async () => {
      await progress.cancel();
    });
    await flush();

    expect(call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(dialogElement().textContent).not.toContain(t('compare.failed'));
    expect(progress.getState().job).toBeUndefined();
  });
});
