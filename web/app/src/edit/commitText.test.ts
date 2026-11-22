import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { PageObjectDto, RectDto, RunResult } from '../rpc/generated';
import {
  type CommitDeps,
  commitText,
  fontChoiceOf,
  offerDroppedText,
  type SettledSelection,
} from './commit';
import { ObjectCache } from './objectCache';

const box = (x0: number, y0: number, x1: number, y1: number): RectDto => ({ x0, y0, x1, y1 });

const paragraph: PageObjectDto = {
  type: 'text',
  key: 'text:3',
  bbox: box(72, 72, 300, 120),
  text: 'Old words',
  style: {
    font: 'Helvetica',
    size: 12,
    color: { r: 0, g: 0, b: 0, a: 1 },
    bold: false,
    italic: false,
    align: 'left',
    line_height: 1.2,
    char_spacing: 0,
    word_spacing: 0,
  },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
};

function reply(value: unknown = null): RunResult {
  return {
    label: 'Edit Text',
    executed: true,
    value,
    changed: { changes: [], revisions: { '0': 5 } },
    state: { history: 9 },
  } as unknown as RunResult;
}

// A fake engine: actions.run answers with `run()` (or rejects), content.objects lists the paragraph.
function setup(run: () => unknown) {
  const call = vi.fn(async (method: string) => {
    if (method === 'actions.run') return run();
    if (method === 'content.objects') {
      return { revision: 5, objects: [paragraph], truncated: false };
    }
    return { done: true, label: 'Edit Text', changed: null, state: { history: 8 } };
  });
  const rpc = { call } as unknown as PageRpc;
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const cache = new ObjectCache(rpc as never, 'h1');
  const deps: CommitDeps = { rpc, handle: 'h1', cache, scheduler: { noteRevisions }, store };
  const settle = vi.fn<(selection: SettledSelection | null) => void>();
  const change = { page: 0, revision: 4, object: paragraph, text: 'New words' };
  return { call, noteRevisions, store, deps, settle, change };
}

const texts = (store: ReturnType<typeof createToastStore>) =>
  store.getState().visible.map((toast) => toast.text);

describe('committing a typed paragraph', () => {
  it('sends one content.replace_text with the list revision and style null', async () => {
    const { call, deps, settle, change } = setup(() => reply());
    const outcome = await commitText(deps, change, settle);
    expect(outcome).toBe('done');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.replace_text',
      args: {
        object: { page: 0, key: 'text:3', revision: 4 },
        text: 'New words',
        style: null,
      },
    });
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toHaveLength(1);
  });

  it('offers Undo with the text-changed message on success', async () => {
    const { store, deps, settle, change } = setup(() => reply());
    await commitText(deps, change, settle);
    expect(texts(store)).toEqual([t('edit.textEdited')]);
    expect(store.getState().visible[0]?.action?.label).toBe(t('toast.undo'));
  });

  it('warns with the name and the missing characters when the engine substituted the font', async () => {
    const value = { name: 'Helvetica', embedded_reused: false, substituted: true, missing: 'Ü€' };
    const { store, deps, settle, change } = setup(() => reply(value));
    await commitText(deps, change, settle);
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('warning');
    expect(toast?.text).toBe(
      `${t('edit.text.substituted', { name: 'Helvetica' })} ${t('edit.text.missing', { chars: 'Ü€' })}`,
    );
    expect(toast?.action?.label).toBe(t('toast.undo'));
  });

  it('reselects the block nearest its old box in the new list', async () => {
    const { deps, settle, change } = setup(() => reply());
    await commitText(deps, change, settle);
    expect(settle).toHaveBeenCalledWith({ page: 0, revision: 5, keys: ['text:3'] });
  });

  it('refreshes the page and offers Copy text on a stale object, changing nothing', async () => {
    const { call, store, deps, settle, change } = setup(() => {
      throw new RpcError('STALE_OBJECT', 'stale');
    });
    const outcome = await commitText(deps, change, settle);
    expect(outcome).toBe('failed');
    expect(settle).toHaveBeenCalledWith(null);
    expect(call).toHaveBeenCalledWith('content.objects', { handle: 'h1', page: 0 });
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('warning');
    expect(toast?.text).toBe(t('edit.text.stale'));
    expect(toast?.action?.label).toBe(t('edit.text.copy'));
  });

  it('keeps the editor open on a busy engine, with the usual message', async () => {
    const { store, deps, settle, change } = setup(() => {
      throw new RpcError('BUSY', 'busy');
    });
    expect(await commitText(deps, change, settle)).toBe('busy');
    expect(settle).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(1);
  });

  it('offers Copy text when a refusal leaves the document unchanged', async () => {
    const { store, deps, settle, change } = setup(() => {
      throw new RpcError('NOT_SUPPORTED', 'no');
    });
    expect(await commitText(deps, change, settle)).toBe('failed');
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('error');
    expect(toast?.action?.label).toBe(t('edit.text.copy'));
  });

  it('closes with nothing said when the engine did not execute the step', async () => {
    const { store, deps, settle, change } = setup(() => ({ ...reply(), executed: false }));
    expect(await commitText(deps, change, settle)).toBe('done');
    expect(store.getState().visible).toHaveLength(0);
  });
});

describe('the font choice reply', () => {
  it('reads a FontChoice and rejects anything else', () => {
    const choice = { name: 'Arial', embedded_reused: true, substituted: false, missing: '' };
    expect(fontChoiceOf(choice)).toEqual(choice);
    expect(fontChoiceOf(null)).toBeNull();
    expect(fontChoiceOf({ name: 'Arial' })).toBeNull();
    expect(fontChoiceOf('Arial')).toBeNull();
  });
});

describe('a dropped paragraph', () => {
  it('offers the typed text as an info toast with Copy text, and sends nothing', async () => {
    const { call, store } = setup(() => reply());
    offerDroppedText('Kept words', store);
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('edit.text.dropped'));
    expect(toast?.action?.label).toBe(t('edit.text.copy'));
    expect(call).not.toHaveBeenCalled();
  });

  it('Copy text puts the typed text on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const { store } = setup(() => reply());
      offerDroppedText('Kept words', store);
      store.getState().visible[0]?.action?.run();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('Kept words'));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
