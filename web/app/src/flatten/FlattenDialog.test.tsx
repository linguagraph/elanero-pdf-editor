import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { createJobProgressStore, type JobProgressStore } from '../feedback/jobRun';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { FlattenDialog, type FlattenDialogProps } from './FlattenDialog';

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

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

// The job worker's reply to job.run: a mutating job returns its document as the one binary value.
function workerReply(): ActionJobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'document',
      label: 'Flatten Comments',
      require_full_save: true,
      document: { $bin: 0 },
      files: [],
      value: 6,
      name: '',
    },
    events: [],
  };
  return {
    call: vi.fn(async () => ({ reply: JSON.stringify(reply), buffer: PDF_BYTES.slice(0) })),
    terminate: vi.fn(),
  };
}

// A worker that never answers, so the job stays running until the test cancels it.
function hangingWorker(): ActionJobWorker {
  return { call: vi.fn(() => new Promise<never>(() => undefined)), terminate: vi.fn() };
}

// A fake engine: each method answers from the table the test gives, and every call is recorded.
function fakeEngine(answers: Record<string, (params: unknown) => unknown>) {
  const call = vi.fn(async (method: string, params: unknown) => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer(params);
  });
  return { call, rpc: { call, chunked: vi.fn() } as unknown as PageRpc };
}

const READY = {
  'comments.flattenable': () => ({ count: 6, pages: 1 }),
  'jobs.prepare': () => ({
    token: 'j1',
    label: 'annotations.flatten',
    mutating: true,
    document: PDF_BYTES.slice(0),
    state: null,
  }),
  'jobs.apply': () => ({
    applied: true,
    changed: { revisions: { '0': 5 }, pages: [0] },
    state: {},
  }),
  'jobs.abort': () => ({}),
};

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

// Lets the promises settle, inside act so React sees the updates.
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

function hasButton(text: string): boolean {
  return [...document.querySelectorAll('button')].some((button) => button.textContent === text);
}

function setup(
  answers: Record<string, (params: unknown) => unknown> = READY,
  overrides: Partial<FlattenDialogProps> = {},
) {
  const { call, rpc } = fakeEngine(answers);
  const store: ToastStore = createToastStore();
  const progress: JobProgressStore = createJobProgressStore({ toasts: store });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const startWorker = vi.fn(workerReply);
  const props: FlattenDialogProps = {
    isOpen: true,
    onClose,
    engine: rpc,
    handle: 'h1',
    startWorker,
    onChanged,
    store,
    progress,
    ...overrides,
  };
  act(() => root.render(<FlattenDialog {...props} />));
  return { call, store, progress, onClose, onChanged, startWorker };
}

const jobCalls = (call: ReturnType<typeof vi.fn>) =>
  call.mock.calls.filter(([method]) => method === 'jobs.prepare' || method === 'jobs.apply');

describe('FlattenDialog (W7.9)', () => {
  it('asks for confirmation before any job runs', async () => {
    const { call, startWorker } = setup();
    await settle();

    expect(document.body.textContent).toContain(t('flatten.confirm.body'));
    expect(hasButton(t('flatten.confirm.run'))).toBe(true);
    expect(call).toHaveBeenCalledWith('comments.flattenable', { handle: 'h1' });
    expect(jobCalls(call)).toEqual([]);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('puts the focus on Cancel when it opens', async () => {
    setup();
    await settle();

    expect(document.activeElement).toBe(buttonNamed(t('flatten.confirm.cancel')));
  });

  it('cancel closes the dialog and does nothing', async () => {
    const { call, startWorker, onClose, onChanged, store } = setup();
    await settle();

    act(() => buttonNamed(t('flatten.confirm.cancel')).click());
    await settle();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(jobCalls(call)).toEqual([]);
    expect(startWorker).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(store.getState().visible).toEqual([]);
  });

  it('confirm runs the annotations.flatten action job, then redraws and says so', async () => {
    const { call, onClose, onChanged, store } = setup();
    await settle();

    act(() => buttonNamed(t('flatten.confirm.run')).click());
    await settle();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('jobs.prepare', {
      handle: 'h1',
      job: 'action',
      args: { name: 'annotations.flatten', args: { refs: null } },
    });
    expect(call).toHaveBeenCalledWith(
      'jobs.apply',
      expect.objectContaining({ handle: 'h1', token: 'j1', label: 'Flatten Comments' }),
    );
    expect(onChanged).toHaveBeenCalledWith({ revisions: { '0': 5 }, pages: [0] });
    const done = store.getState().visible.find((toast) => toast.text === t('flatten.done'));
    expect(done?.kind).toBe('info');
  });

  it('with no comments it says so and runs no job, no undo step and no redraw', async () => {
    const { call, startWorker, onChanged, store } = setup({
      ...READY,
      'comments.flattenable': () => ({ count: 0, pages: 0 }),
    });
    await settle();

    expect(document.body.textContent).toContain(t('flatten.none'));
    expect(document.body.textContent).not.toContain(t('flatten.confirm.body'));
    expect(hasButton(t('flatten.close'))).toBe(true);
    expect(hasButton(t('flatten.confirm.run'))).toBe(false);
    expect(jobCalls(call)).toEqual([]);
    expect(startWorker).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(store.getState().visible).toEqual([]);
  });

  it('shows the encrypted-document message when the browser refuses the job', async () => {
    const { store, onChanged } = setup({
      ...READY,
      'jobs.prepare': () => {
        throw new RpcError('REFUSED', 'refused', { reason: 'encrypted_mutating_job' });
      },
    });
    await settle();

    act(() => buttonNamed(t('flatten.confirm.run')).click());
    await settle();

    expect(store.getState().visible.map((toast) => toast.text)).toEqual([
      t('job.encryptedRefused'),
    ]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows the generic failure toast and redraws nothing when the job fails', async () => {
    const { store, onChanged } = setup({
      ...READY,
      'jobs.prepare': () => {
        throw new Error('boom');
      },
    });
    await settle();

    act(() => buttonNamed(t('flatten.confirm.run')).click());
    await settle();

    const toast = store.getState().visible.find((item) => item.text === t('flatten.failed'));
    expect(toast?.kind).toBe('error');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('redraws nothing when the user cancels the running job', async () => {
    const { call, store, progress, onChanged, startWorker } = setup();
    startWorker.mockImplementation(hangingWorker);
    await settle();

    act(() => buttonNamed(t('flatten.confirm.run')).click());
    await settle();
    expect(progress.getState().job).toBeDefined();

    await act(async () => {
      await progress.cancel();
    });
    await settle();

    expect(call).toHaveBeenCalledWith('jobs.abort', expect.objectContaining({ handle: 'h1' }));
    expect(call).not.toHaveBeenCalledWith('jobs.apply', expect.anything());
    expect(onChanged).not.toHaveBeenCalled();
    expect(store.getState().visible.map((toast) => toast.text)).not.toContain(t('flatten.done'));
  });
});

describe('FlattenDialog on a signed document (W7.9)', () => {
  it('shows the signed note, and the flatten still runs', async () => {
    const { call, onClose, onChanged } = setup(READY, { signed: true });
    await settle();

    expect(document.body.textContent).toContain(t('flatten.signedNote'));
    act(() => buttonNamed(t('flatten.confirm.run')).click());
    await settle();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('jobs.apply', expect.objectContaining({ handle: 'h1' }));
    expect(onChanged).toHaveBeenCalledWith({ revisions: { '0': 5 }, pages: [0] });
  });

  it('an unsigned document shows no signed note', async () => {
    setup();
    await settle();

    expect(document.body.textContent).toContain(t('flatten.confirm.body'));
    expect(document.body.textContent).not.toContain(t('flatten.signedNote'));
  });
});
