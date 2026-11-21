import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t, tp } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { SplitDialog, type SplitDialogProps } from './SplitDialog';
import type { JobWorker, SplitEngine } from './splitJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

function oneFileReply(name: string): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [{ name, mime: 'application/pdf', data: { $bin: 0 } }],
      value: null,
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply), buffer: PDF_BYTES };
}

// The parts split.plan reports for the preview. The default is one part.
const ONE_PART = [{ name: 'report_1.pdf', first_page: 0, page_count: 3 }];

function fakeEngine(
  parts: readonly { name: string; first_page: number; page_count: number }[] = ONE_PART,
) {
  const call = vi.fn(async (method: string) => {
    if (method === 'split.plan') return { parts };
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'split',
        mutating: false,
        document: PDF_BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as SplitEngine };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => 'blob:split-test');
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
  props: Partial<SplitDialogProps> & { progress: JobProgressStore; engine: SplitEngine },
) {
  const full: SplitDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    pageCount: 10,
    name: 'report.pdf',
    startWorker: () => fakeWorker(),
    ...props,
  };
  act(() => root.render(<SplitDialog {...full} />));
  return full;
}

function fakeWorker(
  reply: Promise<CallResult> | CallResult = oneFileReply('split/part-1.pdf'),
): JobWorker {
  return {
    call: vi.fn(() => Promise.resolve(reply)),
    terminate: vi.fn(),
  };
}

function findButton(label: string): HTMLButtonElement {
  const button = [...dialogElement().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button ${label}`);
  return button;
}

function chooseMode(label: string) {
  const radio = [...dialogElement().querySelectorAll('input[type="radio"]')].find(
    (candidate) => candidate.closest('label')?.textContent === label,
  ) as HTMLInputElement | undefined;
  if (radio === undefined) throw new Error(`no mode ${label}`);
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

// The preview asks after a short pause (PREVIEW_DELAY_MS in SplitDialog.tsx); wait past it.
async function waitForPreview() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

function radioNamed(label: string): HTMLInputElement {
  const radio = [...dialogElement().querySelectorAll('input[type="radio"]')].find(
    (candidate) => candidate.closest('label')?.textContent === label,
  ) as HTMLInputElement | undefined;
  if (radio === undefined) throw new Error(`no radio ${label}`);
  return radio;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SplitDialog', () => {
  it('refuses an empty range before any job starts', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    chooseMode(t('split.mode.ranges'));

    act(() => findButton(t('split.submit')).click());
    await flush();

    expect(dialogElement().textContent).toContain(t('split.error.ranges.empty'));
    expect(call).not.toHaveBeenCalled();
  });

  it('calls prepare, run and apply in order, then offers each file as a download', async () => {
    const { call, engine } = fakeEngine();
    const worker = fakeWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => worker });
    chooseMode(t('split.mode.ranges'));
    typeInto('input[type="text"]', '1-3, 5');

    act(() => findButton(t('split.submit')).click());
    await flush();

    expect(
      call.mock.calls
        .map((entry) => entry[0])
        .filter((name) => name !== 'system.memory' && name !== 'split.plan'),
    ).toEqual(['jobs.prepare', 'jobs.apply']);
    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'split',
      args: { mode: 'ranges', ranges: [[0, 1, 2], [4]] },
    });
    expect(worker.call).toHaveBeenCalledTimes(1);
    const link = dialogElement().querySelector<HTMLAnchorElement>('a.split-download');
    expect(link?.textContent).toBe(t('split.download', { name: 'part-1.pdf' }));
    expect(link?.getAttribute('download')).toBe('part-1.pdf');
    expect(link?.getAttribute('href')).toBe('blob:split-test');
  });

  it('shows the files the split makes, with their pages, after the preview', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    chooseMode(t('split.mode.ranges'));
    typeInto('input[type="text"]', '1-3, 5');
    await waitForPreview();

    expect(call).toHaveBeenCalledWith('split.plan', {
      handle: 'doc-1',
      mode: 'ranges',
      pages_per_file: 1,
      ranges: [[0, 1, 2], [4]],
      name: 'report.pdf',
    });
    expect(dialogElement().textContent).toContain(tp('split.preview.heading', 1));
    expect(dialogElement().textContent).toContain('report_1.pdf');
  });

  it('defaults to one ZIP above ten files, until the user picks an output', async () => {
    const parts = Array.from({ length: 11 }, (_, index) => ({
      name: `report_${index + 1}.pdf`,
      first_page: index,
      page_count: 1,
    }));
    const { call, engine } = fakeEngine(parts);
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    await waitForPreview();

    expect(radioNamed(t('split.output.zip')).checked).toBe(true);
    chooseMode(t('split.output.files'));
    act(() => findButton(t('split.submit')).click());
    await flush();

    const prepare = call.mock.calls.find((entry) => entry[0] === 'jobs.prepare') as
      [string, { args: Record<string, unknown> }] | undefined;
    expect(prepare?.[1].args).toMatchObject({ name: 'report.pdf', zip: false });
  });

  it('sends the ZIP option to the job, with the document name', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    chooseMode(t('split.output.zip'));
    act(() => findButton(t('split.submit')).click());
    await flush();

    const prepare = call.mock.calls.find((entry) => entry[0] === 'jobs.prepare') as
      [string, { args: Record<string, unknown> }] | undefined;
    expect(prepare?.[1].args).toMatchObject({ name: 'report.pdf', zip: true });
  });

  it('makes no preview call for a size split and says the sizes come after the split', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    chooseMode(t('split.mode.size'));
    await waitForPreview();

    expect(call.mock.calls.map((entry) => entry[0])).not.toContain('split.plan');
    expect(dialogElement().textContent).toContain(t('split.preview.size'));
  });

  it('shows the size message when the job reports that the files are too large', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const error = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: false,
      error: { code: 'FILE_TOO_LARGE', message: 'too large', details: {} },
      events: [],
    });
    render({
      engine,
      progress,
      startWorker: () => fakeWorker({ reply: error, buffer: undefined }),
    });
    chooseMode(t('split.mode.bookmarks'));
    act(() => findButton(t('split.submit')).click());
    await flush();

    expect(dialogElement().textContent).toContain(t('split.error.tooLarge', { size: '512 MB' }));
  });

  it('shows the running state and the job bar while the job runs', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    let finish: (result: CallResult) => void = () => undefined;
    const pending = new Promise<CallResult>((resolve) => {
      finish = resolve;
    });
    render({ engine, progress, startWorker: () => fakeWorker(pending) });
    chooseMode(t('split.mode.bookmarks'));

    act(() => findButton(t('split.submit')).click());
    await flush();

    expect(dialogElement().textContent).toContain(t('split.running'));
    expect(progress.getState().job?.token).toBe('j1');

    await act(async () => {
      finish(oneFileReply('split/part-1.pdf'));
      await Promise.resolve();
    });
    await flush();
    expect(dialogElement().textContent).not.toContain(t('split.running'));
  });

  it('refuses a page number of zero for every N pages', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });
    typeInto('input[type="number"]', '0');

    act(() => findButton(t('split.submit')).click());
    await flush();

    expect(dialogElement().textContent).toContain(t('split.error.pagesPerFile', { count: 10 }));
    expect(call).not.toHaveBeenCalled();
  });
});
