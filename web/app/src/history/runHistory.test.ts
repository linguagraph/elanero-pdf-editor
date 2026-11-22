import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { RpcError, type RpcErrorCode } from '../rpc/client';
import type { HistoryResult } from '../rpc/generated';
import { createToastStore } from '../feedback/toasts';
import { historyRefresh, runHistoryStep, type HistoryTarget } from './runHistory';

describe('historyRefresh', () => {
  const changed = (...kinds: string[]) => ({
    changes: kinds.map((kind) => ({ kind, pages: [] })),
    revisions: {},
  });

  it('asks only for the bookmarks reload when a step changed the outline alone', () => {
    // An Undo of a bookmark edit must not remount the view, which would put the reader on page 1.
    expect(historyRefresh(changed('outline'))).toEqual({ structure: false, outline: true });
  });

  it('asks for the remount when a step changed the structure', () => {
    expect(historyRefresh(changed('structure', 'outline'))).toEqual({
      structure: true,
      outline: true,
    });
    expect(historyRefresh(changed('structure'))).toEqual({ structure: true, outline: false });
  });

  it('asks for neither when a step changed only content, or reported nothing', () => {
    expect(historyRefresh(changed('content', 'annotations'))).toEqual({
      structure: false,
      outline: false,
    });
    expect(historyRefresh(null)).toEqual({ structure: false, outline: false });
  });
});

const reply = (done: boolean): HistoryResult =>
  ({ done, label: 'Rotate pages', changed: null, state: {} }) as unknown as HistoryResult;

function target(call: ReturnType<typeof vi.fn>, extra: Partial<HistoryTarget> = {}): HistoryTarget {
  return {
    rpc: { call } as unknown as Pick<PageRpc, 'call'>,
    handle: 'doc-1',
    store: createToastStore(),
    ...extra,
  };
}

describe('runHistoryStep', () => {
  it('undoes the newest step through the engine, without an expect_history guard', async () => {
    const call = vi.fn().mockResolvedValue(reply(true));
    const onDone = vi.fn();
    const outcome = await runHistoryStep('undo', target(call, { onDone }));
    expect(call).toHaveBeenCalledWith('actions.undo', { handle: 'doc-1', expect_history: null });
    expect(outcome).toBe('done');
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ done: true }));
  });

  it('redoes through the engine with only the handle', async () => {
    const call = vi.fn().mockResolvedValue(reply(true));
    expect(await runHistoryStep('redo', target(call))).toBe('done');
    expect(call).toHaveBeenCalledWith('actions.redo', { handle: 'doc-1' });
  });

  it('does nothing quietly when the engine has no step in that direction', async () => {
    const call = vi.fn().mockResolvedValue(reply(false));
    const onDone = vi.fn();
    const store = createToastStore();
    expect(await runHistoryStep('undo', target(call, { onDone, store }))).toBe('nothing');
    expect(onDone).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(0);
  });

  it('reports an engine refusal as a toast and changes nothing else', async () => {
    const call = vi.fn().mockRejectedValue(new RpcError('BUSY' as RpcErrorCode, 'busy'));
    const onDone = vi.fn();
    const store = createToastStore();
    expect(await runHistoryStep('redo', target(call, { onDone, store }))).toBe('failed');
    expect(onDone).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(1);
  });

  it('reports a non-RPC failure with the redo message', async () => {
    const call = vi.fn().mockRejectedValue(new Error('network'));
    const store = createToastStore();
    expect(await runHistoryStep('redo', target(call, { store }))).toBe('failed');
    expect(store.getState().visible[0]?.text).toBe(t('toast.redo.failed'));
  });
});
