import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { isMoveClick, transformComments, type TransformDeps, translation } from './transform';

function setup(
  reply: unknown = { executed: true, changed: { revisions: { '0': 5 } }, state: { history: 9 } },
) {
  const call = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const deps: TransformDeps = {
    rpc: { call } as unknown as PageRpc,
    handle: 'h1',
    scheduler: { noteRevisions },
    store,
  };
  return { call, noteRevisions, store, deps };
}

const refs = [{ page: 0, name: 'a' }];

describe('comment move and resize', () => {
  it('a move under half a point on both axes is a click', () => {
    expect(isMoveClick(0.4, 0.2)).toBe(true);
    expect(isMoveClick(0.5, 0)).toBe(false);
    expect(isMoveClick(0, -0.6)).toBe(false);
  });

  it('a translation is the identity with the offset in e and f', () => {
    expect(translation(3, -4)).toEqual([1, 0, 0, 1, 3, -4]);
  });

  it('sends one annotations.transform with the refs, the matrix and resize false', async () => {
    const { call, deps } = setup();
    const ok = await transformComments(deps, refs, translation(10, 20), false, () => {});
    expect(ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.transform',
      args: {
        refs: [{ page: 0, name: 'a' }],
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 },
        resize: false,
      },
    });
  });

  it('a resize sends resize true and redraws the changed page with an Undo toast', async () => {
    const { noteRevisions, store, deps } = setup();
    await transformComments(deps, refs, [1.5, 0, 0, 2, -5, -10], true, () => {});
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 5 });
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('comment.resized'));
  });

  it('a move says the comment moved', async () => {
    const { store, deps } = setup();
    await transformComments(deps, refs, translation(1, 1), false, () => {});
    expect(store.getState().visible[0]?.text).toBe(t('comment.moved'));
  });

  it('an engine that skips the change (locked) changes nothing and shows nothing', async () => {
    const { noteRevisions, store, deps } = setup({
      executed: false,
      changed: null,
      state: { history: 9 },
    });
    const ok = await transformComments(deps, refs, translation(1, 1), false, () => {});
    expect(ok).toBe(false);
    expect(noteRevisions).not.toHaveBeenCalled();
    expect(store.getState().visible).toEqual([]);
  });

  it('a stale comment clears the selection through onStale and says so', async () => {
    const onStale = vi.fn();
    const { store, deps } = setup(new RpcError('STALE_OBJECT', 'gone'));
    const ok = await transformComments(deps, refs, translation(1, 1), false, onStale);
    expect(ok).toBe(false);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(store.getState().visible[0]?.text).toBe(t('comments.stale'));
  });

  it('another failure is reported as a move or resize failure', async () => {
    const onStale = vi.fn();
    const { store, deps } = setup(new Error('network'));
    const ok = await transformComments(deps, refs, translation(1, 1), false, onStale);
    expect(ok).toBe(false);
    expect(onStale).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.text).toBe(t('comment.transform.failed'));
  });
});
