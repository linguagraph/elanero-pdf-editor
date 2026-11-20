import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { createToastStore } from '../feedback/toasts';
import { t, tp } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { ExtractFontsDialog, type ExtractFontsDialogProps } from './ExtractFontsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

const BYTES = new Uint8Array([0, 1, 0, 0]).buffer;

interface FontsValue {
  saved?: string[];
  not_embedded?: string[];
  refused?: { name: string; reason: string }[];
}

// A job reply as extract_fonts writes it: kind "files" with its value, one $bin buffer per file.
function fontsReply(files: readonly string[], value: FontsValue): CallResult {
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
        mime: name.endsWith('.zip') ? 'application/zip' : 'font/ttf',
        data: { $bin: index },
      })),
      value: {
        saved: value.saved ?? [],
        not_embedded: value.not_embedded ?? [],
        refused: value.refused ?? [],
      },
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
        label: 'extract_fonts',
        mutating: false,
        document: BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as FileJobEngine };
}

function fakeWorker(reply: CallResult | Error): JobWorker {
  const call =
    reply instanceof Error
      ? vi.fn(() => Promise.reject(reply))
      : vi.fn(() => Promise.resolve(reply));
  return { call, terminate: vi.fn() };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => 'blob:extract-fonts-test');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function render(
  props: Partial<ExtractFontsDialogProps> & { progress: JobProgressStore; engine: FileJobEngine },
) {
  const full: ExtractFontsDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    name: 'Report.pdf',
    startWorker: () => fakeWorker(fontsReply([], {})),
    ...props,
  };
  act(() => root.render(<ExtractFontsDialog {...full} />));
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

function submit() {
  act(() => findButton(t('extract.submit')).click());
}

describe('ExtractFontsDialog', () => {
  it('runs extract_fonts on the whole document, then offers the ZIP and names the refused fonts', async () => {
    const { call, engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () =>
        fakeWorker(
          fontsReply(['licensed-fonts.zip'], {
            saved: ['Free Sans Regular.ttf', 'Print Sans Regular.ttf'],
            refused: [
              { name: 'Bitmap Sans Regular', reason: 'bitmap_only' },
              { name: 'Restricted Sans Regular', reason: 'restricted' },
            ],
          }),
        ),
    });

    submit();
    await flush();

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'extract_fonts',
      args: { name: 'Report.pdf' },
    });
    expect(document.body.textContent).toContain(tp('extract.fonts.saved', 2));
    expect(document.body.textContent).toContain(
      tp('extract.fonts.refused', 2, { names: 'Bitmap Sans Regular, Restricted Sans Regular' }),
    );
    const link = document.body.querySelector<HTMLAnchorElement>('a.export-download');
    expect(link?.textContent).toBe(t('export.download', { name: 'licensed-fonts.zip' }));
    expect(document.body.textContent).toContain(t('export.archive.hint'));
  });

  it('lists the first ten refused names and says how many are left out', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const refused = Array.from({ length: 12 }, (_, i) => ({
      name: `Font ${i + 1}`,
      reason: 'restricted',
    }));
    render({ engine, progress, startWorker: () => fakeWorker(fontsReply([], { refused })) });

    submit();
    await flush();

    const shown = refused
      .slice(0, 10)
      .map((font) => font.name)
      .join(', ');
    const more = t('extract.fonts.more', { count: 2 });
    expect(document.body.textContent).toContain(
      tp('extract.fonts.refused', 12, { names: `${shown}, ${more}` }),
    );
    expect(document.body.textContent).toContain('Font 10');
    expect(document.body.textContent).not.toContain('Font 11');
  });

  it('shows the refusal, not a count of zero, when every font was refused', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () =>
        fakeWorker(
          fontsReply([], { refused: [{ name: 'Restricted Sans', reason: 'restricted' }] }),
        ),
    });

    submit();
    await flush();

    expect(document.body.textContent).toContain(
      tp('extract.fonts.refused', 1, { names: 'Restricted Sans' }),
    );
    expect(document.body.textContent).not.toContain(tp('extract.fonts.saved', 0));
    expect(document.body.textContent).not.toContain(t('extract.fonts.none'));
    expect(document.body.querySelector('a.export-download')).toBeNull();
  });

  it('names the fonts with no program in the document', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({
      engine,
      progress,
      startWorker: () => fakeWorker(fontsReply([], { not_embedded: ['Helvetica'] })),
    });

    submit();
    await flush();

    expect(document.body.textContent).toContain(t('extract.fonts.none'));
    expect(document.body.textContent).toContain(
      tp('extract.fonts.notEmbedded', 1, { names: 'Helvetica' }),
    );
  });

  it('shows the failure line when the run fails', async () => {
    const { engine } = fakeEngine();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => fakeWorker(new Error('worker lost')) });

    submit();
    await flush();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      t('extract.fonts.failed'),
    );
  });
});
