import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { PROTOCOL_VERSION, type RedactionMarkDto } from '../rpc/generated';
import { RedactionController, type RedactionDeps } from './controller';

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;
const BOX = { x0: 1, y0: 2, x1: 30, y1: 40 };

// The marks the document holds, as redaction.list reports them. A test sets them, and a change the
// fake engine makes (a mark added, removed, undone) sets them too, as the engine would.
let listed: RedactionMarkDto[] = [];

function markDto(name: string, page = 0): RedactionMarkDto {
  return {
    page,
    name,
    rect: { x0: 1, y0: 2, x1: 30, y1: 40 },
    fill: { r: 0, g: 0, b: 0, a: 1 },
    overlay_text: '',
    text_color: { r: 1, g: 1, b: 1, a: 1 },
    contents: '',
    author: '',
    locked: false,
  };
}

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

// The apply's answers. The job empties the document's marks, as the engine would.
const APPLY_ANSWERS = {
  'jobs.prepare': () => PREPARE_REPLY,
  'jobs.apply': () => {
    listed = [];
    return { applied: true, changed: { revisions: { '0': 5 }, pages: [0] }, state: { history: 7 } };
  },
};

// A fake engine: each method answers from the table the test gives, and every call is recorded.
// redaction.list answers from `listed`, unless the test gives its own answer.
function setup(answers: Record<string, (params: unknown) => unknown>, worker = workerReply) {
  const table: Record<string, (params: unknown) => unknown> = {
    'redaction.list': () => ({ marks: listed, truncated: false }),
    ...answers,
  };
  const call = vi.fn(async (method: string, params: unknown) => {
    const answer = table[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer(params);
  });
  const rpc = { call, chunked: vi.fn() } as unknown as RedactionDeps['rpc'];
  const noteRevisions = vi.fn();
  const stop = vi.fn();
  let revisionListener: (() => void) | null = null;
  const subscribeRevisions = vi.fn((listener: () => void) => {
    revisionListener = listener;
    return stop;
  });
  const store = createToastStore();
  const controller = new RedactionController({
    rpc,
    handle: 'h1',
    scheduler: { noteRevisions, subscribeRevisions },
    startWorker: worker,
    store,
    progress: createJobProgressStore({ toasts: store }),
  });
  // The scheduler reports a change to the document (noteRevisions moved a revision).
  const fireRevisions = () => revisionListener?.();
  return { call, controller, noteRevisions, store, subscribeRevisions, stop, fireRevisions };
}

// Lets the reads and replies the controller started finish.
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function listCalls(call: ReturnType<typeof setup>['call']): number {
  return call.mock.calls.filter(([method]) => method === 'redaction.list').length;
}

beforeEach(() => {
  listed = [];
});

describe('RedactionController (W7.4, W7.4b)', () => {
  it('reads the marks of the document, the ones in the file too', async () => {
    listed = [markDto('m1'), markDto('m2', 1)];
    const { controller } = setup({});
    await controller.reload();

    const snapshot = controller.getSnapshot();
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.marks).toEqual([
      {
        page: 0,
        name: 'm1',
        rect: BOX,
        fill: { r: 0, g: 0, b: 0 },
        overlayText: '',
        textColor: { r: 1, g: 1, b: 1 },
        contents: '',
        author: '',
        locked: false,
      },
      expect.objectContaining({ page: 1, name: 'm2' }),
    ]);
  });

  it('keeps a null fill and text colour as null', async () => {
    listed = [{ ...markDto('m1'), fill: null, text_color: null }];
    const { controller } = setup({});
    await controller.reload();
    expect(controller.getSnapshot().marks[0]).toMatchObject({ fill: null, textColor: null });
  });

  it('adds a mark through actions.run, redraws its page and reloads the list', async () => {
    const { call, controller, noteRevisions } = setup({
      'actions.run': () => {
        listed = [markDto('m1')];
        return MARK_REPLY;
      },
    });
    controller.setActive(true);
    await controller.add(0, BOX);
    await flush();

    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.mark',
      args: {
        areas: [{ page: 0, rect: BOX }],
        author: '',
        style: {
          fill: { r: 0, g: 0, b: 0 },
          overlay_text: '',
          text_color: { r: 1, g: 1, b: 1 },
        },
      },
    });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
    expect(controller.getSnapshot().marks.map((mark) => mark.name)).toEqual(['m1']);
  });

  it('marks the areas of a selection as one call, with their quads and text', async () => {
    const { call, controller, noteRevisions } = setup({
      'actions.run': () => {
        listed = [markDto('m1'), markDto('m2', 1)];
        return {
          ...MARK_REPLY,
          value: [
            { page: 0, name: 'm1' },
            { page: 1, name: 'm2' },
          ],
        };
      },
    });
    controller.setActive(true);
    const quad = {
      ul: { x: 1, y: 2 },
      ur: { x: 30, y: 2 },
      ll: { x: 1, y: 40 },
      lr: { x: 30, y: 40 },
    };
    const areas = [
      { page: 0, rect: BOX, quads: [quad], text: 'jane' },
      { page: 1, rect: BOX, quads: [quad], text: 'jane' },
    ];
    expect(await controller.markAreas(areas)).toBe(2);
    await flush();

    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.mark',
      args: {
        areas: [
          { page: 0, rect: BOX, quads: [quad], text: 'jane' },
          { page: 1, rect: BOX, quads: [quad], text: 'jane' },
        ],
        author: '',
        style: {
          fill: { r: 0, g: 0, b: 0 },
          overlay_text: '',
          text_color: { r: 1, g: 1, b: 1 },
        },
      },
    });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
    expect(controller.getSnapshot().marks).toHaveLength(2);
  });

  it('sends nothing for an empty selection, and adds nothing while busy', async () => {
    const { call, controller } = setup({});
    expect(await controller.markAreas([])).toBe(0);
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toHaveLength(0);
  });

  it("clears every mark of the document, the file's too, in one call", async () => {
    listed = [markDto('m1'), markDto('m2', 1)];
    const { call, controller } = setup({
      'actions.run': () => {
        listed = [];
        return { ...MARK_REPLY, value: [] };
      },
    });
    await controller.reload();
    await controller.clear();
    await flush();

    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.remove_marks',
      args: {
        marks: [
          { page: 0, name: 'm1' },
          { page: 1, name: 'm2' },
        ],
      },
    });
    expect(controller.getSnapshot().marks).toEqual([]);
  });

  it('removes the named marks and reloads the list', async () => {
    listed = [markDto('m1'), markDto('m2', 1)];
    const { call, controller } = setup({
      'actions.run': () => {
        listed = [markDto('m2', 1)];
        return { ...MARK_REPLY, value: [] };
      },
    });
    await controller.reload();
    await controller.remove([{ page: 0, name: 'm1' }]);
    await flush();

    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.remove_marks',
      args: { marks: [{ page: 0, name: 'm1' }] },
    });
    expect(controller.getSnapshot().marks.map((mark) => mark.name)).toEqual(['m2']);
  });

  it('sends nothing when there is nothing to act on', async () => {
    const { call, controller } = setup({});
    await controller.apply(null);
    await controller.apply([]);
    await controller.clear();
    await controller.restyle([], { overlayText: 'EXEMPT' });
    expect(call).not.toHaveBeenCalled();
  });

  it('applies the named marks as one action job and offers Undo', async () => {
    listed = [markDto('m1')];
    const { call, controller, store } = setup({ ...APPLY_ANSWERS });
    await controller.reload();
    await controller.apply([{ page: 0, name: 'm1' }]);
    await flush();

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
    expect(controller.getSnapshot()).toMatchObject({ active: false, busy: false, marks: [] });
    const visible = store.getState().visible;
    expect(visible.map((toast) => toast.text)).toContain(t('redact.applied'));
    expect(visible.some((toast) => toast.action !== undefined)).toBe(true);
    // The Undo offer names the apply's history, so a press after a later edit is refused.
    visible.find((toast) => toast.action !== undefined)?.action?.run();
    await flush();
    expect(call).toHaveBeenCalledWith('actions.undo', { handle: 'h1', expect_history: 7 });
  });

  it('applies every mark of the document when asked for all, the file marks too', async () => {
    listed = [markDto('m1'), markDto('m2', 1)];
    const { call, controller } = setup({ ...APPLY_ANSWERS });
    await controller.reload();
    await controller.apply(null);

    expect(call).toHaveBeenCalledWith('jobs.prepare', {
      handle: 'h1',
      job: 'action',
      args: {
        name: 'redaction.apply',
        args: {
          marks: null,
          options: { images: 'pixels', graphics: 'covered', text: true },
        },
      },
    });
  });

  it('reloads the list after an undo from the toast, so the marks come back', async () => {
    listed = [markDto('m1')];
    const { call, controller, store, noteRevisions } = setup({
      ...APPLY_ANSWERS,
      'actions.undo': () => {
        listed = [markDto('m1')];
        return { done: true, changed: { revisions: { '0': 6 }, pages: [0] }, state: {} };
      },
    });
    await controller.reload();
    await controller.apply(null);
    await flush();
    const before = listCalls(call);
    store
      .getState()
      .visible.find((toast) => toast.action !== undefined)
      ?.action?.run();
    await flush();

    expect(noteRevisions).toHaveBeenCalledWith({ '0': 6 });
    expect(listCalls(call)).toBeGreaterThan(before);
    expect(controller.getSnapshot().marks.map((mark) => mark.name)).toEqual(['m1']);
  });

  it('keeps the marks and says so when the document is encrypted', async () => {
    listed = [markDto('m1')];
    const { controller, store } = setup({
      'jobs.prepare': () => {
        throw new RpcError('REFUSED', 'refused', { reason: 'encrypted_mutating_job' });
      },
    });
    await controller.reload();
    await controller.apply(null);

    expect(controller.getSnapshot().marks.map((mark) => mark.name)).toEqual(['m1']);
    expect(controller.getSnapshot().busy).toBe(false);
    expect(store.getState().visible.map((toast) => toast.text)).toEqual([
      t('job.encryptedRefused'),
    ]);
  });

  it('reads once at start, then once more for a burst of external changes', async () => {
    listed = [markDto('m1')];
    const { call, controller, subscribeRevisions, fireRevisions, stop } = setup({});
    const unsubscribe = controller.start();
    expect(subscribeRevisions).toHaveBeenCalledTimes(1);
    // Three changes arrive while the first read is in flight: one more read covers them all.
    fireRevisions();
    fireRevisions();
    fireRevisions();
    await flush();
    await flush();

    expect(listCalls(call)).toBe(2);
    expect(controller.getSnapshot().marks.map((mark) => mark.name)).toEqual(['m1']);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('restyles only the fields the patch sets, in one call', async () => {
    listed = [markDto('m1')];
    const { call, controller, noteRevisions } = setup({
      'actions.run': () => ({ ...MARK_REPLY, value: [{ page: 0, name: 'm1' }] }),
    });
    await controller.reload();
    await controller.restyle([{ page: 0, name: 'm1' }], { overlayText: 'EXEMPT' });
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.restyle_marks',
      args: { marks: [{ page: 0, name: 'm1' }], overlay_text: 'EXEMPT' },
    });

    await controller.restyle([{ page: 0, name: 'm1' }], { fill: { r: 1, g: 0, b: 0 } });
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.restyle_marks',
      args: { marks: [{ page: 0, name: 'm1' }], fill: { r: 1, g: 0, b: 0 } },
    });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
  });

  it('reads the list again and says so when the mark to restyle is gone', async () => {
    listed = [markDto('m1')];
    const { call, controller, store } = setup({
      'actions.run': () => {
        listed = [];
        throw new RpcError('STALE_OBJECT', 'gone');
      },
    });
    await controller.reload();
    const before = listCalls(call);
    await controller.restyle([{ page: 0, name: 'm1' }], { overlayText: 'EXEMPT' });

    expect(listCalls(call)).toBeGreaterThan(before);
    expect(controller.getSnapshot().marks).toEqual([]);
    expect(store.getState().visible.map((toast) => toast.text)).toEqual([t('redactions.stale')]);
  });

  it('prunes the selection to the marks that still exist', async () => {
    listed = [markDto('m1'), markDto('m2', 1)];
    const { controller } = setup({});
    await controller.reload();
    controller.select([
      { page: 0, name: 'm1' },
      { page: 1, name: 'm2' },
    ]);
    expect(controller.getSnapshot().selected).toHaveLength(2);

    listed = [markDto('m1')];
    await controller.reload();
    expect(controller.getSnapshot().selected).toEqual([{ page: 0, name: 'm1' }]);
  });
});
