import { describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { RedactionController, type RedactionDeps } from './controller';

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;
const BOX = { x0: 1, y0: 2, x1: 30, y1: 40 };

// The job worker's reply to job.run: a mutating job returns its document as the one binary value.
function workerReply(): ActionJobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'document',
      label: 'Apply Redaction',
      require_full_save: true,
      document: { $bin: 0 },
      files: [],
      value: { areas: 1, images_checked: 0, leaks: [], unverified: [] },
      name: '',
    },
    events: [],
  };
  return {
    call: vi.fn(async () => ({ reply: JSON.stringify(reply), buffer: PDF_BYTES.slice(0) })),
    terminate: vi.fn(),
  };
}

const MARK_REPLY = {
  label: 'Mark for Redaction',
  executed: true,
  value: [{ page: 0, name: 'm1' }],
  changed: { revisions: { '0': 4 }, pages: [0] },
  state: {},
};

const PREPARE_REPLY = {
  token: 'j1',
  label: 'Apply Redaction',
  mutating: true,
  document: PDF_BYTES.slice(0),
  state: null,
};

// A fake engine: each method answers from the table the test gives, and every call is recorded.
function setup(answers: Record<string, (params: unknown) => unknown>, worker = workerReply) {
  const call = vi.fn(async (method: string, params: unknown) => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer(params);
  });
  const rpc = { call, chunked: vi.fn() } as unknown as RedactionDeps['rpc'];
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const controller = new RedactionController({
    rpc,
    handle: 'h1',
    scheduler: { noteRevisions },
    startWorker: worker,
    store,
    progress: createJobProgressStore({ toasts: store }),
  });
  return { call, controller, noteRevisions, store };
}

describe('RedactionController (W7.4)', () => {
  it('adds a mark through actions.run and redraws the page it changed', async () => {
    const { call, controller, noteRevisions } = setup({ 'actions.run': () => MARK_REPLY });
    controller.setActive(true);
    await controller.add(0, BOX);

    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.mark',
      args: { areas: [{ page: 0, rect: BOX }] },
    });
    expect(controller.getSnapshot().marks).toEqual([{ page: 0, name: 'm1' }]);
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
  });

  it('clears the marks that were not applied, in one call', async () => {
    const { call, controller } = setup({ 'actions.run': () => MARK_REPLY });
    await controller.add(0, BOX);
    await controller.clear();
    expect(call).toHaveBeenLastCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.remove_marks',
      args: { marks: [{ page: 0, name: 'm1' }] },
    });
    expect(controller.getSnapshot().marks).toEqual([]);
  });

  it('does not run an apply with no marks', async () => {
    const { call, controller } = setup({});
    await controller.apply();
    expect(call).not.toHaveBeenCalled();
  });

  it('applies the marks as one action job and offers Undo', async () => {
    const { call, controller, store } = setup({
      'actions.run': () => MARK_REPLY,
      'jobs.prepare': () => PREPARE_REPLY,
      'jobs.apply': () => ({
        applied: true,
        changed: { revisions: { '0': 5 }, pages: [0] },
        state: {},
      }),
    });
    await controller.add(0, BOX);
    await controller.apply();

    expect(call).toHaveBeenCalledWith('jobs.prepare', {
      handle: 'h1',
      job: 'action',
      args: {
        name: 'redaction.apply',
        args: {
          marks: [{ page: 0, name: 'm1' }],
          options: { images: 'pixels', graphics: 'covered', text: true },
        },
      },
    });
    expect(call).toHaveBeenCalledWith(
      'jobs.apply',
      expect.objectContaining({ handle: 'h1', token: 'j1', label: 'Apply Redaction' }),
    );
    expect(controller.getSnapshot()).toEqual({ active: false, marks: [], busy: false });
    const visible = store.getState().visible;
    expect(visible.map((toast) => toast.text)).toContain(t('redact.applied'));
    expect(visible.some((toast) => toast.action !== undefined)).toBe(true);
  });

  it('keeps the marks and says so when the document is encrypted', async () => {
    const { controller, store } = setup({
      'actions.run': () => MARK_REPLY,
      'jobs.prepare': () => {
        throw new RpcError('REFUSED', 'refused', { reason: 'encrypted_mutating_job' });
      },
    });
    await controller.add(0, BOX);
    await controller.apply();

    expect(controller.getSnapshot().marks).toEqual([{ page: 0, name: 'm1' }]);
    expect(controller.getSnapshot().busy).toBe(false);
    expect(store.getState().visible.map((toast) => toast.text)).toEqual([
      t('job.encryptedRefused'),
    ]);
  });
});
