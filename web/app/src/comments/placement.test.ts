import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { RpcError } from '../rpc/client';
import { type PlacementDeps, placeComment } from './placement';

const rect = { x0: 72, y0: 72, x1: 144, y1: 144 };

function setup(executed = true) {
  const call = vi.fn(async (method: string) => {
    if (method === 'actions.run') {
      return {
        label: 'Add Rectangle',
        executed,
        value: null,
        changed: { changes: [], revisions: { '0': 3 } },
        state: { history: 7 },
      };
    }
    return {
      done: true,
      label: 'Add Rectangle',
      changed: { changes: [], revisions: { '0': 4 } },
      state: { history: 6 },
    };
  });
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const deps: PlacementDeps = {
    rpc: { call } as unknown as PageRpc,
    handle: 'h1',
    scheduler: { noteRevisions },
    stamps: { read: async () => undefined },
    store,
  };
  return { call, noteRevisions, store, deps };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('placing a custom stamp', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e]);
  const picture = { size: 3, arrayBuffer: async () => bytes.buffer, text: async () => '' };
  const id = 'a'.repeat(64);

  it('sends the picture as a buffer and the label as the text, with no stamp name', async () => {
    const { call, deps } = setup();
    const read = vi.fn(async () => picture);
    await placeComment({ ...deps, stamps: { read } }, 'stamp', 0, rect, '', [], {
      id,
      label: 'Logo',
    });
    expect(read).toHaveBeenCalledWith(id);
    const params = call.mock.calls[0] as unknown as [string, { args: Record<string, unknown> }];
    const { args } = params[1];
    expect(args['image']).toBeInstanceOf(ArrayBuffer);
    expect(args['text']).toBe('Logo');
    expect(args['stamp']).toBe('');
  });

  it('a stamp the library no longer has is reported and nothing is sent', async () => {
    const { call, store, deps } = setup();
    const stamps = { read: async () => undefined };
    await placeComment({ ...deps, stamps }, 'stamp', 0, rect, '', [], { id, label: 'Gone' });
    expect(call).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.text).toBe(t('stamp.custom.unreadable'));
  });
});

describe('placing a comment', () => {
  it('runs annotations.create with the tool, the page and the box', async () => {
    const { call, deps } = setup();
    await placeComment(deps, 'rectangle', 0, rect, '');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'rectangle', page: 0, rect, text: '', points: [], author: '' },
    });
  });

  it('sends the two ends of a line or arrow as points', async () => {
    const { call, deps } = setup();
    const ends = [
      { x: 72, y: 72 },
      { x: 144, y: 100 },
    ];
    await placeComment(deps, 'arrow', 0, rect, '', ends);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'arrow', page: 0, rect, text: '', points: ends, author: '' },
    });
  });

  it('sends the author name saved in the preferences (W4.5 S3)', async () => {
    const { call, deps } = setup();
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ authorName: 'Ada' }));
    await placeComment(deps, 'note', 0, rect, 'Hi');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'note', page: 0, rect, text: 'Hi', points: [], author: 'Ada' },
    });
    window.localStorage.clear();
  });

  it('redraws the changed page and shows an info toast with Undo', async () => {
    const { noteRevisions, store, deps } = setup();
    await placeComment(deps, 'highlight', 0, rect, '');
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 3 });
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('comment.added'));
    expect(toast?.action?.label).toBe(t('toast.undo'));
  });

  it('shows nothing when the engine did not add a comment', async () => {
    const { store, noteRevisions, deps } = setup(false);
    await placeComment(deps, 'note', 0, rect, 'Hi');
    expect(store.getState().visible).toEqual([]);
    expect(noteRevisions).not.toHaveBeenCalled();
  });

  it('Undo undoes the offered step (its history) and redraws the page it changed', async () => {
    const { call, noteRevisions, store, deps } = setup();
    await placeComment(deps, 'rectangle', 0, rect, '');
    noteRevisions.mockClear();
    store.getState().visible[0]?.action?.run();
    await settle();
    expect(call).toHaveBeenLastCalledWith('actions.undo', { handle: 'h1', expect_history: 7 });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
  });

  it('a stale Undo says so and redraws nothing', async () => {
    const { call, noteRevisions, store, deps } = setup();
    await placeComment(deps, 'rectangle', 0, rect, '');
    noteRevisions.mockClear();
    call.mockRejectedValueOnce(new RpcError('STALE_OBJECT', 'changed', { history: 9 }));
    store.getState().visible[0]?.action?.run();
    await settle();
    expect(noteRevisions).not.toHaveBeenCalled();
    expect(store.getState().visible.at(-1)?.text).toBe(t('toast.undo.stale'));
  });
});
