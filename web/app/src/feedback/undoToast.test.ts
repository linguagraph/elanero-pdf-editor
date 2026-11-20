import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { HistoryResult } from '../rpc/generated';
import { offerUndo, undoOffered, type UndoOffer } from './undoToast';
import { createToastStore } from './toasts';

const reply = (done: boolean): HistoryResult =>
  ({ done, label: 'Page deleted', changed: null, state: {} }) as unknown as HistoryResult;

function makeOffer(call: ReturnType<typeof vi.fn>, extra: Partial<UndoOffer> = {}): UndoOffer {
  return {
    rpc: { call } as unknown as Pick<PageRpc, 'call'>,
    handle: 'doc-1',
    history: 7,
    store: createToastStore(),
    ...extra,
  };
}

describe('undoOffered', () => {
  it('sends the offered history with the undo', async () => {
    const call = vi.fn().mockResolvedValue(reply(true));
    await undoOffered(makeOffer(call));
    expect(call).toHaveBeenCalledWith('actions.undo', { handle: 'doc-1', expect_history: 7 });
  });

  it('calls onUndone once with the reply when the undo went through', async () => {
    const result = reply(true);
    const call = vi.fn().mockResolvedValue(result);
    const onUndone = vi.fn();
    const offer = makeOffer(call, { onUndone });
    await expect(undoOffered(offer)).resolves.toBe('undone');
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(onUndone).toHaveBeenCalledWith(result);
    expect(offer.store?.getState().visible).toHaveLength(0);
  });

  it.each(['STALE_OBJECT', 'NO_DOCUMENT'] as const)(
    'shows the quiet stale notice for %s and does not call onUndone',
    async (code) => {
      const call = vi.fn().mockRejectedValue(new RpcError(code, 'nope'));
      const onUndone = vi.fn();
      const offer = makeOffer(call, { onUndone });
      await expect(undoOffered(offer)).resolves.toBe('stale');
      expect(onUndone).not.toHaveBeenCalled();
      const [toast] = offer.store?.getState().visible ?? [];
      expect(toast?.kind).toBe('info');
      expect(toast?.text).toBe(t('toast.undo.stale'));
    },
  );

  it('treats a reply that undid nothing as stale', async () => {
    const call = vi.fn().mockResolvedValue(reply(false));
    const onUndone = vi.fn();
    const offer = makeOffer(call, { onUndone });
    await expect(undoOffered(offer)).resolves.toBe('stale');
    expect(onUndone).not.toHaveBeenCalled();
    expect(offer.store?.getState().visible[0]?.text).toBe(t('toast.undo.stale'));
  });

  it('reports other RPC errors through the catalogue as an error toast', async () => {
    const call = vi.fn().mockRejectedValue(new RpcError('BUSY', 'busy'));
    const offer = makeOffer(call);
    await expect(undoOffered(offer)).resolves.toBe('failed');
    const [toast] = offer.store?.getState().visible ?? [];
    expect(toast?.kind).toBe('error');
    expect(toast?.text).toBe(t('error.BUSY'));
  });

  it('shows the fallback error for a non-RPC failure', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    const offer = makeOffer(call);
    await expect(undoOffered(offer)).resolves.toBe('failed');
    const [toast] = offer.store?.getState().visible ?? [];
    expect(toast?.kind).toBe('error');
    expect(toast?.text).toBe(t('toast.undo.failed'));
  });
});

describe('offerUndo', () => {
  it('pushes one toast whose action is labelled Undo and runs the undo with the offered history', async () => {
    const call = vi.fn().mockResolvedValue(reply(true));
    const offer = makeOffer(call);
    const id = offerUndo('success', 'Page deleted.', offer);

    const queue = offer.store?.getState();
    expect(queue?.visible).toHaveLength(1);
    expect(queue?.visible[0]?.id).toBe(id);
    expect(queue?.visible[0]?.action?.label).toBe(t('toast.undo'));

    queue?.visible[0]?.action?.run();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith('actions.undo', { handle: 'doc-1', expect_history: 7 });
  });
});

// Every Undo goes through the helper, so the stale and error policy is in one place (W4.4b). A
// caller that sent actions.undo itself would skip the history check.
describe('actions.undo has two callers', () => {
  // undoToast.ts sends an offered step with expect_history (W4.4b). The Undo command (W4.3a S8)
  // takes the newest step, as the desktop's Ctrl+Z does, and sends no guard. No other sender.
  it('is sent only from undoToast.ts and the Undo command', () => {
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(src);
    const senders = files.filter((file) => /'actions\.undo'\s*,/.test(readFileSync(file, 'utf8')));
    expect(senders.map((file) => relative(src, file).split(/[\\/]/).join('/')).sort()).toEqual([
      'feedback/undoToast.ts',
      'history/runHistory.ts',
    ]);
  });
});
