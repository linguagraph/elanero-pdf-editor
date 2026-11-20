import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { tp } from '../i18n/t';
import type { RunResult } from '../rpc/generated';
import { runCrop } from './runCrop';

const ARGS = { pages: [0, 2], left: 36, top: 0, right: 0, bottom: 12 };

function run(executed: boolean, history = 4): RunResult {
  return {
    label: 'Crop 2 Pages',
    executed,
    value: null,
    changed: executed ? { changes: [], revisions: { '0': 2, '2': 2 } } : null,
    state: { history } as unknown as RunResult['state'],
  };
}

describe('runCrop', () => {
  it('sends pages.crop_margins with the arguments as given', async () => {
    const call = vi.fn().mockResolvedValue(run(true));
    const rpc = { call } as unknown as Pick<PageRpc, 'call'>;
    await runCrop({ rpc, handle: 'doc-1', store: createToastStore() }, ARGS);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'pages.crop_margins',
      args: { pages: [0, 2], left: 36, top: 0, right: 0, bottom: 12 },
    });
  });

  it('redraws the changed pages and offers Undo for that one step', async () => {
    const call = vi.fn().mockResolvedValue(run(true, 9));
    const rpc = { call } as unknown as Pick<PageRpc, 'call'>;
    const store = createToastStore();
    const onChanged = vi.fn();
    await runCrop({ rpc, handle: 'doc-1', store, onChanged }, ARGS);
    expect(onChanged).toHaveBeenCalledWith({ changes: [], revisions: { '0': 2, '2': 2 } });
    const [toast] = store.getState().visible;
    expect(toast?.text).toBe(tp('crop.done', 2));
    expect(toast?.action).toBeDefined();
    // The Undo button names the history of this step, so a later step is never undone by it.
    toast?.action?.run();
    await vi.waitFor(() =>
      expect(call).toHaveBeenLastCalledWith('actions.undo', {
        handle: 'doc-1',
        expect_history: 9,
      }),
    );
  });

  it('does nothing when the engine found nothing to crop', async () => {
    const call = vi.fn().mockResolvedValue(run(false));
    const rpc = { call } as unknown as Pick<PageRpc, 'call'>;
    const store = createToastStore();
    const onChanged = vi.fn();
    const reply = await runCrop({ rpc, handle: 'doc-1', store, onChanged }, ARGS);
    expect(reply.executed).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(0);
  });
});
