import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { createJobProgressStore } from '../feedback/jobRun';
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

// Lets the job's promises settle, inside act so React sees the updates.
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

function setup(
  answers: Record<string, (params: unknown) => unknown> = READY,
  overrides: Partial<FlattenDialogProps> = {},
) {
  const { call, rpc } = fakeEngine(answers);
  const store: ToastStore = createToastStore();
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
    progress: createJobProgressStore({ toasts: store }),
    ...overrides,
  };
  act(() => root.render(<FlattenDialog {...props} />));
  return { call, store, onClose, onChanged, startWorker };
}

describe('FlattenDialog (W7.9)', () => {
  it('asks for confirmation before any job runs', async () => {
    const { call, startWorker } = setup();
    await settle();

    expect(document.body.textContent).toContain(t('flatten.confirm.body'));
    expect(buttonNamed(t('flatten.confirm.run'))).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('cancel closes the dialog and does nothing', async () => {
    const { call, startWorker, onClose, onChanged, store } = setup();
    await settle();

    act(() => buttonNamed(t('flatten.confirm.cancel')).click());
    await settle();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
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
    const visible = store.getState().visible;
    expect(visible.map((toast) => toast.text)).toContain(t('flatten.done'));
    expect(visible.find((toast) => toast.text === t('flatten.done'))?.kind).toBe('info');
  });

  it('shows the encrypted-document message when the browser refuses the job', async () => {
    const { store, onChanged } = setup({
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
});
