import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { FileJobEngine, JobWorker } from '../files/fileJob';
import { t } from '../i18n/t';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { SpaceUsageDialog, type SpaceUsageDialogProps } from './SpaceUsageDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

// The audit as the job reports it (AuditValue): the engine's English name is not read.
function auditValue(sizes: Record<string, number>, total: number) {
  return {
    total,
    categories: Object.entries(sizes).map(([key, size]) => ({ key, name: key, size })),
  };
}

function reportReply(value: unknown): CallResult {
  return {
    reply: JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: { kind: 'report', label: '', require_full_save: false, document: null, value },
      events: [],
    }),
  };
}

function errorReply(): CallResult {
  return {
    reply: JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: false,
      error: { code: 'INTERNAL', message: 'boom' },
      events: [],
    }),
  };
}

// A worker whose reply the test decides: pending until resolved.
function deferredWorker() {
  let resolve: (value: CallResult) => void = () => undefined;
  const reply = new Promise<CallResult>((done) => {
    resolve = done;
  });
  const worker: JobWorker = { call: vi.fn(() => reply), terminate: vi.fn() };
  return { worker, finish: (value: CallResult) => resolve(value) };
}

function fakeEngine() {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'Space Usage',
        mutating: false,
        document: new ArrayBuffer(4),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call, engine: { call } as unknown as FileJobEngine };
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

function render(
  props: Partial<SpaceUsageDialogProps> & { progress: JobProgressStore; engine: FileJobEngine },
) {
  const full: SpaceUsageDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    handle: 'doc-1',
    startWorker: () => deferredWorker().worker,
    ...props,
  };
  act(() => root.render(<SpaceUsageDialog {...full} />));
  return full;
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
    await Promise.resolve();
  });
}

function rowTexts(): string[][] {
  return [...document.body.querySelectorAll('table tbody tr')].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''),
  );
}

describe('SpaceUsageDialog', () => {
  it('runs the audit when opened and shows the total', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });
    await flush();

    const prepare = call.mock.calls[0] as unknown as [string, unknown] | undefined;
    expect(prepare?.[1]).toMatchObject({ job: 'audit', args: {} });
    expect(document.body.textContent).toContain(t('spaceUsage.running'));
    expect(findButton(t('spaceUsage.cancel'))).toBeTruthy();

    await act(async () => job.finish(reportReply(auditValue({ images: 100 }, 470))));
    await flush();
    expect(document.body.textContent).toContain(t('spaceUsage.total', { size: '470 B' }));
  });

  it('lists the parts above zero, largest first, file overhead last, with the share in words', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });
    await flush();
    await act(async () =>
      job.finish(
        reportReply(
          auditValue(
            { file_overhead: 20, images: 100, fonts: 0, page_content: 300, other: 50 },
            470,
          ),
        ),
      ),
    );
    await flush();

    const rows = rowTexts();
    expect(rows.map((row) => row[0])).toEqual([
      t('space.category.page_content'),
      t('space.category.images'),
      t('space.category.other'),
      t('space.category.file_overhead'),
    ]);
    expect(rows[0]).toEqual([
      t('space.category.page_content'),
      '300 B',
      t('spaceUsage.share', { percent: 64 }),
    ]);
    expect(rows[3]?.[2]).toBe(t('spaceUsage.share', { percent: 4 }));
    expect(document.body.textContent).toContain(t('spaceUsage.note'));
  });

  it('shows a failed audit inline, with Close and no result', async () => {
    const { engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const onClose = vi.fn();
    render({ engine, progress, startWorker: () => job.worker, onClose });
    await flush();

    await act(async () => job.finish(errorReply()));
    await flush();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(t('spaceUsage.failed'));
    expect(document.body.querySelector('table')).toBeNull();
    act(() => findButton(t('spaceUsage.close')).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers no Close, and Escape does not close it, from the first paint while the audit runs', async () => {
    const closeShown = () =>
      [...document.body.querySelectorAll('button')].some(
        (candidate) => candidate.textContent === t('spaceUsage.close'),
      );
    // The audit's first engine call runs inside the dialog's effect, right after the first paint
    // is committed and before any state update from that effect renders. Close must not be there.
    const base = fakeEngine();
    let closeOnFirstPaint: boolean | undefined;
    const engine = {
      call: vi.fn(async (method: string) => {
        if (method === 'jobs.prepare') closeOnFirstPaint = closeShown();
        return base.call(method);
      }),
    } as unknown as FileJobEngine;
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    const onClose = vi.fn();
    const full: SpaceUsageDialogProps = {
      isOpen: true,
      onClose,
      handle: 'doc-1',
      engine,
      progress,
      startWorker: () => job.worker,
    };
    act(() => {
      flushSync(() => root.render(<SpaceUsageDialog {...full} />));
    });
    await flush();
    expect(closeOnFirstPaint).toBe(false);
    expect(closeShown()).toBe(false);
    expect(findButton(t('spaceUsage.cancel'))).toBeTruthy();

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels the running audit with Cancel, which is not an error', async () => {
    const { call, engine } = fakeEngine();
    const job = deferredWorker();
    const progress = createJobProgressStore({ toasts: createToastStore() });
    render({ engine, progress, startWorker: () => job.worker });
    await flush();

    await act(async () => {
      findButton(t('spaceUsage.cancel')).click();
      await Promise.resolve();
    });
    await flush();

    expect(call.mock.calls.some((c) => c[0] === 'jobs.abort')).toBe(true);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(findButton(t('spaceUsage.close'))).toBeTruthy();
  });
});
