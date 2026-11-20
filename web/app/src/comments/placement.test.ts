import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { type PlacementDeps, placeComment, undoComment } from './placement';

const rect = { x0: 72, y0: 72, x1: 144, y1: 144 };

function setup(executed = true) {
  const call = vi.fn(async (method: string) => {
    if (method === 'actions.run') {
      return {
        label: 'Add Rectangle',
        executed,
        value: null,
        changed: { changes: [], revisions: { '0': 3 } },
        state: {},
      };
    }
    return {
      done: true,
      label: 'Add Rectangle',
      changed: { changes: [], revisions: { '0': 4 } },
      state: {},
    };
  });
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const deps: PlacementDeps = {
    rpc: { call } as unknown as PageRpc,
    handle: 'h1',
    scheduler: { noteRevisions },
    store,
  };
  return { call, noteRevisions, store, deps };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('placing a comment', () => {
  it('runs annotations.create with the tool, the page and the box', async () => {
    const { call, deps } = setup();
    await placeComment(deps, 'rectangle', 0, rect, '');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'rectangle', page: 0, rect, text: '', author: '' },
    });
  });

  it('sends the author name saved in the preferences (W4.5 S3)', async () => {
    const { call, deps } = setup();
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ authorName: 'Ada' }));
    await placeComment(deps, 'note', 0, rect, 'Hi');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'note', page: 0, rect, text: 'Hi', author: 'Ada' },
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

  it('Undo calls actions.undo and redraws the page it changed', async () => {
    const { call, noteRevisions, store, deps } = setup();
    await placeComment(deps, 'rectangle', 0, rect, '');
    noteRevisions.mockClear();
    store.getState().visible[0]?.action?.run();
    await settle();
    expect(call).toHaveBeenLastCalledWith('actions.undo', { handle: 'h1', expect_history: null });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
  });

  it('an undo with nothing to undo redraws nothing', async () => {
    const { call, noteRevisions, deps } = setup();
    call.mockResolvedValueOnce({ done: false, label: '', changed: null, state: {} } as never);
    await undoComment(deps);
    expect(noteRevisions).not.toHaveBeenCalled();
  });
});
