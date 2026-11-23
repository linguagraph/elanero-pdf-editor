import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { RectDto, RunResult } from '../rpc/generated';
import { textLayerPassive } from '../text/textLayerPassive';
import { acceptSignedEdit, requestEditTool } from './editTool';
import { type CommitDeps, commitAdd, DEFAULT_TEXT_STYLE, newTextBlock } from './commit';
import { DEFAULT_TEXT_ARG } from './textStyle';
import { ObjectCache } from './objectCache';

const box = (x0: number, y0: number, x1: number, y1: number): RectDto => ({ x0, y0, x1, y1 });
const RECT = box(72, 300, 272, 340);

function reply(): RunResult {
  return {
    label: 'Add Text',
    executed: true,
    value: null,
    changed: { changes: [], revisions: { '0': 6 } },
    state: { history: 10 },
  } as unknown as RunResult;
}

// A fake engine: actions.run answers with `run()` (or throws).
function setup(run: () => unknown) {
  const call = vi.fn(async (method: string) => {
    if (method === 'actions.run') return run();
    return { done: true, label: 'Add Text', changed: null, state: { history: 9 } };
  });
  const rpc = { call } as unknown as PageRpc;
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const cache = new ObjectCache(rpc as never, 'h1');
  const deps: CommitDeps = { rpc, handle: 'h1', cache, scheduler: { noteRevisions }, store };
  return { call, noteRevisions, store, deps };
}

const texts = (store: ReturnType<typeof createToastStore>) =>
  store.getState().visible.map((toast) => toast.text);

describe('adding a typed block (Add Text)', () => {
  it('sends one content.add_text with the box, the text and the default style', async () => {
    const { call, deps } = setup(() => reply());
    expect(await commitAdd(deps, { page: 0, rect: RECT, text: 'New block' })).toBe('done');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.add_text',
      args: { page: 0, rect: RECT, text: 'New block', style: DEFAULT_TEXT_ARG },
    });
  });

  it('sends the desktop default: Helvetica 12, black, left', () => {
    expect(DEFAULT_TEXT_STYLE).toMatchObject({
      font: 'Helvetica',
      size: 12,
      color: { r: 0, g: 0, b: 0, a: 1 },
      align: 'left',
    });
  });

  it('does not send a blank text, and closes without a step', async () => {
    const { call, deps, store } = setup(() => reply());
    expect(await commitAdd(deps, { page: 0, rect: RECT, text: '  \n\t' })).toBe('done');
    expect(call).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(0);
  });

  it('offers one Undo step with the text-added message', async () => {
    const { store, deps } = setup(() => reply());
    await commitAdd(deps, { page: 0, rect: RECT, text: 'New block' });
    expect(texts(store)).toEqual([t('edit.textAdded')]);
    expect(store.getState().visible[0]?.action?.label).toBe(t('toast.undo'));
  });

  it('keeps the editor open on a busy engine, with the usual message', async () => {
    const { store, deps } = setup(() => {
      throw new RpcError('BUSY', 'busy');
    });
    expect(await commitAdd(deps, { page: 0, rect: RECT, text: 'New block' })).toBe('busy');
    expect(store.getState().visible).toHaveLength(1);
  });

  it('offers Copy text when a refusal adds nothing', async () => {
    const { store, deps } = setup(() => {
      throw new RpcError('REFUSED', 'Page 9 doesnt exist.');
    });
    expect(await commitAdd(deps, { page: 0, rect: RECT, text: 'New block' })).toBe('failed');
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('error');
    expect(toast?.action?.label).toBe(t('edit.text.copy'));
  });

  it('builds the stand-in block of a new paragraph at its box, with no key', () => {
    const block = newTextBlock(RECT);
    expect(block).toMatchObject({ type: 'text', key: '', bbox: RECT, text: '', editable: true });
    expect(block.style).toEqual(DEFAULT_TEXT_ARG);
  });
});

describe('the Add Text tool and the signed-document warning', () => {
  it('asks once per tab, then turns the tool on without asking again', () => {
    const tab = 9101;
    expect(requestEditTool(tab, true, 'add-text')).toBe(false);
    acceptSignedEdit(tab, 'add-text');
    expect(requestEditTool(tab, true, 'add-text')).toBe(true);
    expect(requestEditTool(9102, true, 'add-text')).toBe(false);
  });

  it('does not ask for an unsigned document', () => {
    expect(requestEditTool(9103, false, 'add-text')).toBe(true);
  });

  it('is a passive text layer while armed, so a drag draws the box and not a selection', () => {
    const idle = { commentTool: null, viewTool: 'select', markToolOn: false } as const;
    expect(textLayerPassive({ ...idle, viewTool: 'add-text' })).toBe(true);
  });
});
