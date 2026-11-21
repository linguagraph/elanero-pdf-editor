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

// The wire form of an audit (AuditValue): the total and the categories by key, with the engine's
// English name that the dialog does not read.
interface AuditJson {
  total: number;
  categories: { key: string; name: string; size: number }[];
}

function auditJson(sizes: Record<string, number>): AuditJson {
  const categories = Object.entries(sizes).map(([key, size]) => ({ key, name: key, size }));
  return { total: categories.reduce((sum, item) => sum + item.size, 0), categories };
}

// A job reply for reduce_size: one reduced.pdf and the sizes the job reports (ReduceSizeValue).
function reduceReply(
  before: number,
  after: number,
  audits: { before: AuditJson; after: AuditJson } | null = null,
): CallResult {
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
      value: {
        before,
        after,
        notes: [],
        audit_before: audits?.before ?? null,
        audit_after: audits?.after ?? null,
      },
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
      t('compress.notSmaller', { before: '1000 B', after: '1.2 KB' }),
    );
    expect(document.body.querySelector('a.compress-download')).toBeNull();
    expect(document.body.textContent).not.toContain(
      t('compress.result.sizes', { before: '1000 B', after: '1.2 KB', percent: 0 }),
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

describe('CompressDialog controls', () => {
  function radio(label: string): HTMLInputElement {
    const found = [...document.body.querySelectorAll('input[type="radio"]')].find(
      (candidate) => candidate.closest('label')?.textContent === label,
    ) as HTMLInputElement | undefined;
    if (found === undefined) throw new Error(`no option ${label}`);
    return found;
  }

  function pressEscape() {
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
  }

  it('disables the presets and ignores a second submit while the job runs', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    submit();
    await flush();

    expect(radio(t('compress.preset.print')).disabled).toBe(true);
    expect(findButton(t('compress.submit')).disabled).toBe(true);
    const form = document.body.querySelector('form.compress');
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(call.mock.calls.filter((entry) => entry[0] === 'jobs.prepare')).toHaveLength(1);
    expect(job.worker.call).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape while the job runs, and does once it has finished', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const onClose = vi.fn();
    render({ engine, progress, onClose, startWorker: () => job.worker });

    submit();
    await flush();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => job.finish(reduceReply(2_000_000, 500_000)));
    await flush();
    pressEscape();
    expect(onClose).toHaveBeenCalled();
  });

  it('Close calls onClose before any job has run', () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const onClose = vi.fn();
    render({ engine, progress, onClose });

    act(() => findButton(t('compress.close')).click());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Keep the original calls onClose when the copy is not smaller', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const onClose = vi.fn();
    render({ engine, progress, onClose, startWorker: () => job.worker });

    submit();
    await flush();
    await act(async () => job.finish(reduceReply(1000, 1200)));
    await flush();
    act(() => findButton(t('compress.keep')).click());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts from the defaults when the dialog is opened again', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const full = render({ engine, progress });
    choose(t('compress.preset.print'));
    expect(radio(t('compress.preset.print')).checked).toBe(true);

    act(() => root.render(<CompressDialog {...full} isOpen={false} />));
    act(() => root.render(<CompressDialog {...full} isOpen={true} />));

    expect(radio(t('compress.preset.ebook')).checked).toBe(true);
    expect(radio(t('compress.preset.print')).checked).toBe(false);
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

describe('CompressDialog custom settings', () => {
  // The field whose label reads `text` (each field is a wrapping label, so its text is the label).
  function field(text: string): HTMLInputElement {
    const label = [...document.body.querySelectorAll('label')].find(
      (candidate) => candidate.textContent === text,
    );
    const input = label?.querySelector('input');
    if (input === null || input === undefined) throw new Error(`no field ${text}`);
    return input;
  }

  // Types into a number field the way a user does: the value, then the input event React reads.
  function type(text: string, value: string) {
    const input = field(text);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function toggle(text: string) {
    act(() => field(text).click());
  }

  function radioChecked(label: string): boolean {
    return [...document.body.querySelectorAll('input[type="radio"]')].some(
      (candidate) =>
        (candidate as HTMLInputElement).checked &&
        candidate.closest('label')?.textContent === label,
    );
  }

  function prepareArgs(call: ReturnType<typeof vi.fn>): unknown {
    const prepare = call.mock.calls.find((entry) => entry[0] === 'jobs.prepare') as
      [string, { args: unknown }] | undefined;
    return prepare?.[1].args;
  }

  it('a preset fills the fields and is sent by its key', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    choose(t('compress.preset.print'));
    expect(field(t('compress.field.dpi')).value).toBe('300');
    expect(field(t('compress.field.quality')).value).toBe('85');

    submit();
    await flush();
    expect(prepareArgs(call)).toEqual({ preset: 'print', audit: true });
  });

  it('editing a field makes the settings Custom and sends the values as options', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    choose(t('compress.preset.ebook'));
    type(t('compress.field.quality'), '40');
    expect(radioChecked(t('compress.preset.custom'))).toBe(true);
    expect(radioChecked(t('compress.preset.ebook'))).toBe(false);
    toggle(t('compress.field.grayscale'));

    submit();
    await flush();
    expect(prepareArgs(call)).toEqual({
      preset: 'custom',
      audit: true,
      options: {
        image_dpi: 150,
        jpeg_quality: 40,
        grayscale: true,
        subset_fonts: true,
        remove_thumbnails: true,
        remove_metadata: false,
        object_streams: true,
      },
    });
  });

  it('Keep image resolution disables the dpi field and sends null', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    toggle(t('compress.field.keep'));
    expect(field(t('compress.field.dpi')).disabled).toBe(true);

    submit();
    await flush();
    expect(prepareArgs(call)).toMatchObject({ preset: 'custom', options: { image_dpi: null } });
  });

  it('an out-of-range dpi shows the message through t() and blocks Compress', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });

    type(t('compress.field.dpi'), '5000');
    expect(document.body.textContent).toContain(t('compress.error.dpi', { min: 36, max: 1200 }));
    expect(findButton(t('compress.submit')).disabled).toBe(true);

    const form = document.body.querySelector('form.compress');
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(call.mock.calls.some((entry) => entry[0] === 'jobs.prepare')).toBe(false);
  });

  it('an empty or out-of-range quality shows its message and blocks Compress', () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress });

    type(t('compress.field.quality'), '');
    expect(document.body.textContent).toContain(t('compress.error.quality', { min: 10, max: 100 }));
    expect(findButton(t('compress.submit')).disabled).toBe(true);

    type(t('compress.field.quality'), '101');
    expect(findButton(t('compress.submit')).disabled).toBe(true);

    type(t('compress.field.quality'), '60');
    expect(document.body.textContent).not.toContain(
      t('compress.error.quality', { min: 10, max: 100 }),
    );
    expect(findButton(t('compress.submit')).disabled).toBe(false);
  });

  it('switches between a preset and Custom, and the fields are disabled while running', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });

    choose(t('compress.preset.custom'));
    expect(radioChecked(t('compress.preset.custom'))).toBe(true);
    expect(document.body.textContent).toContain(t('compress.hint.custom'));

    choose(t('compress.preset.screen'));
    expect(field(t('compress.field.dpi')).value).toBe('72');
    expect(radioChecked(t('compress.preset.custom'))).toBe(false);

    submit();
    await flush();
    expect(field(t('compress.field.dpi')).disabled).toBe(true);
    expect(field(t('compress.field.quality')).disabled).toBe(true);
  });
});

// The space table in the result (W6.4): the audits come from the same job as the sizes.
const KB = 1024;
const AUDIT_BEFORE = auditJson({
  images: 1024 * KB,
  fonts: 400 * KB,
  page_content: 120 * KB,
  comments_forms: 0,
  file_overhead: 2 * KB,
});
const AUDIT_AFTER = auditJson({
  images: 200 * KB,
  fonts: 96 * KB,
  page_content: 120 * KB,
  comments_forms: 0,
  file_overhead: 1 * KB,
});

function auditTable(): HTMLTableElement | null {
  return document.body.querySelector<HTMLTableElement>('table.compress-audit-table');
}

function rowHeaders(): string[] {
  return [...document.body.querySelectorAll('table.compress-audit-table tbody th')].map(
    (cell) => cell.textContent ?? '',
  );
}

async function runWith(
  before: number,
  after: number,
  audits: { before: AuditJson; after: AuditJson } | null,
  settingsChoice?: string,
) {
  const { engine } = fakeEngine();
  const job = deferredWorker();
  const progress = createJobProgressStore({ toasts: createToastStore() });
  render({ engine, progress, startWorker: () => job.worker });
  if (settingsChoice !== undefined) choose(settingsChoice);
  submit();
  await flush();
  await act(async () => job.finish(reduceReply(before, after, audits)));
  await flush();
  return job;
}

describe('CompressDialog space audit', () => {
  it('shows the table with a caption naming the preset, the headers and the rows that changed', async () => {
    await runWith(2_000_000, 500_000, { before: AUDIT_BEFORE, after: AUDIT_AFTER });

    const table = auditTable();
    expect(table).not.toBeNull();
    expect(table?.querySelector('caption')?.textContent).toBe(
      t('compress.audit.caption', { settings: t('compress.preset.ebook') }),
    );
    const headers = [...(table?.querySelectorAll('thead th') ?? [])].map(
      (cell) => cell.textContent,
    );
    expect(headers).toEqual([
      t('compress.audit.part'),
      t('compress.audit.before'),
      t('compress.audit.after'),
      t('compress.audit.change'),
    ]);
    // Zero rows are hidden (comments and forms); file overhead is always the last row.
    expect(rowHeaders()).toEqual([
      t('space.category.images'),
      t('space.category.fonts'),
      t('space.category.page_content'),
      t('space.category.file_overhead'),
    ]);
    const images = table?.querySelector('tbody tr');
    expect(images?.textContent).toContain(t('compress.audit.less', { size: '824.0 KB' }));
    const pageContent = [...(table?.querySelectorAll('tbody tr') ?? [])][2];
    expect(pageContent?.textContent).toContain(t('compress.audit.same'));
    const note = document.getElementById(table?.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe(t('compress.audit.note'));
  });

  it('shows the table in the not-smaller case, with no download', async () => {
    const onClose = vi.fn();
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, onClose, startWorker: () => job.worker });
    choose(t('compress.preset.custom'));
    submit();
    await flush();
    await act(async () =>
      job.finish(reduceReply(1000, 1200, { before: AUDIT_BEFORE, after: AUDIT_AFTER })),
    );
    await flush();

    expect(document.body.querySelector('a.compress-download')).toBeNull();
    expect(auditTable()).not.toBeNull();
    expect(auditTable()?.querySelector('caption')?.textContent).toBe(
      t('compress.audit.caption', { settings: t('compress.preset.custom') }),
    );
  });

  it('clears the result, its table and its download when a setting changes', async () => {
    await runWith(2_000_000, 500_000, { before: AUDIT_BEFORE, after: AUDIT_AFTER });
    expect(document.body.querySelector('a.compress-download')).not.toBeNull();

    choose(t('compress.preset.screen'));

    expect(auditTable()).toBeNull();
    expect(document.body.querySelector('a.compress-download')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:compress-test');
  });

  it('shows the result without a table when the reply has no audits', async () => {
    await runWith(2_000_000, 500_000, null);

    expect(auditTable()).toBeNull();
    expect(document.body.querySelector('a.compress-download')).not.toBeNull();
  });
});
