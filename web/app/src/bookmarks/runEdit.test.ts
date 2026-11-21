import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { runBookmarkEdit } from './runEdit';

// The Undo offer and the error report are checked as calls, not through the toast store.
vi.mock('../feedback/undoToast', () => ({ offerUndo: vi.fn() }));
vi.mock('../feedback/toasts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../feedback/toasts')>()),
  reportRpcError: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeStore() {
  const push = vi.fn(() => 1);
  return { store: { push } as unknown as ToastStore, push };
}

function rpcReplying(result: unknown) {
  const call = vi.fn(() => {
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });
  return { rpc: { call } as unknown as Pick<PageRpc, 'call'>, call };
}

const args = { index: 2, expect_title: 'Old', title: 'New' };
const deps = (rpc: Pick<PageRpc, 'call'>, store: ToastStore) => ({
  rpc,
  handle: 'h',
  onHistoryStep: vi.fn(),
  store,
});

describe('runBookmarkEdit', () => {
  it('sends the action and offers Undo for the step it made', async () => {
    const { store } = fakeStore();
    const reply = {
      label: 'Rename Bookmark',
      executed: true,
      value: null,
      changed: null,
      state: { history: 5 },
    };
    const { rpc, call } = rpcReplying(reply);
    const outcome = await runBookmarkEdit(deps(rpc, store), 'outline.rename', args, 'Renamed');
    expect(outcome).toBe('done');
    expect(call).toHaveBeenCalledWith('actions.run', { handle: 'h', name: 'outline.rename', args });
    expect(offerUndo).toHaveBeenCalledWith(
      'info',
      'Renamed',
      expect.objectContaining({ handle: 'h', history: reply.state.history, store }),
    );
  });

  it('shows nothing when the engine found nothing to do', async () => {
    const { store, push } = fakeStore();
    const { rpc } = rpcReplying({
      label: '',
      executed: false,
      value: null,
      changed: null,
      state: {},
    });
    expect(await runBookmarkEdit(deps(rpc, store), 'outline.move', args, 'x')).toBe('unchanged');
    expect(push).not.toHaveBeenCalled();
    expect(offerUndo).not.toHaveBeenCalled();
  });

  it('tells the user the outline was read again after a stale edit', async () => {
    const { store, push } = fakeStore();
    const { rpc } = rpcReplying(new RpcError('STALE_OBJECT', 'stale'));
    expect(await runBookmarkEdit(deps(rpc, store), 'outline.delete', args, 'x')).toBe('stale');
    expect(push).toHaveBeenCalledWith('info', t('bookmarks.stale'));
  });

  it('reports a refused edit through the RPC error toast', async () => {
    const { store } = fakeStore();
    const error = new RpcError('REFUSED', 'refused');
    const { rpc } = rpcReplying(error);
    expect(await runBookmarkEdit(deps(rpc, store), 'outline.delete', args, 'x')).toBe('failed');
    expect(reportRpcError).toHaveBeenCalledWith(store, error);
    expect(offerUndo).not.toHaveBeenCalled();
  });

  it('reports a busy edit through the RPC error toast', async () => {
    const { store } = fakeStore();
    const error = new RpcError('BUSY', 'busy');
    const { rpc } = rpcReplying(error);
    expect(await runBookmarkEdit(deps(rpc, store), 'outline.move', args, 'x')).toBe('failed');
    expect(reportRpcError).toHaveBeenCalledWith(store, error);
    expect(offerUndo).not.toHaveBeenCalled();
  });

  it('reports a failure that is not an engine error with the generic message', async () => {
    const { store, push } = fakeStore();
    const { rpc } = rpcReplying(new Error('network'));
    expect(await runBookmarkEdit(deps(rpc, store), 'outline.delete', args, 'x')).toBe('failed');
    expect(push).toHaveBeenCalledWith('error', t('bookmarks.editFailed'));
  });
});
