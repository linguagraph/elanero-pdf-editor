import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { PageObjectDto, RectDto } from '../rpc/generated';
import { type CommitDeps, commitEdit, type SettledSelection } from './commit';
import { fitMatrix } from './hitTest';
import { ObjectCache } from './objectCache';

const box = (x0: number, y0: number, x1: number, y1: number): RectDto => ({ x0, y0, x1, y1 });

function obj(key: string, bbox: RectDto): PageObjectDto {
  return { type: 'image', key, bbox, editable: true, reason: '' } as unknown as PageObjectDto;
}

// A fake engine: actions.run answers with the given reply (or rejects), content.objects lists the
// given objects at the given revision, and actions.undo answers as an undone step.
function setup(options: {
  run?: () => unknown;
  revision?: number;
  objects?: PageObjectDto[];
  executed?: boolean;
}) {
  const revision = options.revision ?? 4;
  const call = vi.fn(async (method: string) => {
    if (method === 'actions.run') {
      if (options.run) return options.run();
      return {
        label: 'Move Object',
        executed: options.executed ?? true,
        value: null,
        changed: { changes: [], revisions: { '0': revision } },
        state: { history: 9 },
      };
    }
    if (method === 'content.objects') {
      return { revision, objects: options.objects ?? [], truncated: false };
    }
    return {
      done: true,
      label: 'Move Object',
      changed: { changes: [], revisions: { '0': 5 } },
      state: { history: 8 },
    };
  });
  const rpc = { call } as unknown as PageRpc;
  const noteRevisions = vi.fn();
  const store = createToastStore();
  const cache = new ObjectCache(rpc as never, 'h1');
  const deps: CommitDeps = { rpc, handle: 'h1', cache, scheduler: { noteRevisions }, store };
  const settle = vi.fn<(selection: SettledSelection | null) => void>();
  return { call, noteRevisions, store, cache, deps, settle };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const photo = obj('img1', box(420, 80, 540, 180));

describe('committing a move', () => {
  it('sends content.transform with the revision the keys were listed at', async () => {
    const { call, deps, settle } = setup({});
    await commitEdit(
      deps,
      {
        kind: 'move',
        page: 0,
        revision: 4,
        objects: [photo],
        matrix: [1, 0, 0, 1, 0, 300],
        boxes: [box(420, 380, 540, 480)],
      },
      settle,
    );
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.transform',
      args: {
        objects: [{ page: 0, key: 'img1', revision: 4 }],
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 300 },
        resize: false,
      },
    });
  });

  it('reselects the objects nearest to where they went, after noting the new revision', async () => {
    const moved = obj('img1', box(420, 380, 540, 480));
    const other = obj('txt1', box(72, 60, 300, 80));
    const { noteRevisions, deps, settle } = setup({ revision: 5, objects: [moved, other] });
    await commitEdit(
      deps,
      {
        kind: 'move',
        page: 0,
        revision: 4,
        objects: [photo],
        matrix: [1, 0, 0, 1, 0, 300],
        boxes: [box(420, 380, 540, 480)],
      },
      settle,
    );
    await flush();
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 5 });
    expect(settle).toHaveBeenLastCalledWith({ page: 0, revision: 5, keys: ['img1'] });
  });

  it('offers Undo, and the undo clears the lists and the selection', async () => {
    const { call, store, cache, deps, settle, noteRevisions } = setup({});
    cache.get(0, 4).catch(() => undefined);
    await commitEdit(
      deps,
      {
        kind: 'move',
        page: 0,
        revision: 4,
        objects: [photo],
        matrix: [1, 0, 0, 1, 0, 300],
        boxes: [box(420, 380, 540, 480)],
      },
      settle,
    );
    const toast = store.getState().visible.find((x) => x.action !== undefined);
    expect(toast?.text).toBe(t('edit.moved'));
    toast?.action?.run();
    await flush();
    expect(call).toHaveBeenCalledWith('actions.undo', { handle: 'h1', expect_history: 9 });
    expect(settle).toHaveBeenLastCalledWith(null);
    expect(noteRevisions).toHaveBeenLastCalledWith({ '0': 5 });
  });
});

describe('committing a resize', () => {
  it('sends resize: true with the fit matrix of the box', async () => {
    const { call, deps, settle } = setup({});
    const next = box(420, 80, 600, 180);
    await commitEdit(
      deps,
      {
        kind: 'resize',
        page: 0,
        revision: 4,
        objects: [photo],
        matrix: fitMatrix(photo.bbox, next),
        boxes: [next],
      },
      settle,
    );
    const [, params] = call.mock.calls[0] as unknown as [
      string,
      { args: { resize: boolean; matrix: object } },
    ];
    expect(params.args.resize).toBe(true);
    expect(params.args.matrix).toEqual({ a: 1.5, b: 0, c: 0, d: 1, e: -210, f: 0 });
  });
});

describe('committing a delete', () => {
  it('sends content.delete for the objects and selects nothing', async () => {
    const { call, deps, settle, noteRevisions } = setup({});
    await commitEdit(deps, { kind: 'delete', page: 0, revision: 4, objects: [photo] }, settle);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.delete',
      args: { objects: [{ page: 0, key: 'img1', revision: 4 }] },
    });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
    expect(settle).toHaveBeenCalledWith(null);
  });

  it('sends nothing with no objects', async () => {
    const { call, deps, settle } = setup({});
    await commitEdit(deps, { kind: 'delete', page: 0, revision: 4, objects: [] }, settle);
    expect(call).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('shows no Undo and keeps the selection when the engine did nothing', async () => {
    const { store, deps, settle } = setup({ executed: false });
    await commitEdit(deps, { kind: 'delete', page: 0, revision: 4, objects: [photo] }, settle);
    expect(store.getState().visible).toHaveLength(0);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('a stale object', () => {
  it('re-reads the page, clears the selection and shows a warning', async () => {
    const { call, store, cache, deps, settle, noteRevisions } = setup({
      revision: 7,
      run: () => {
        throw new RpcError('STALE_OBJECT', 'stale');
      },
    });
    cache.get(0, 4).catch(() => undefined);
    await commitEdit(
      deps,
      {
        kind: 'move',
        page: 0,
        revision: 4,
        objects: [photo],
        matrix: [1, 0, 0, 1, 0, 300],
        boxes: [box(420, 380, 540, 480)],
      },
      settle,
    );
    await flush();
    expect(settle).toHaveBeenCalledWith(null);
    expect(call).toHaveBeenCalledWith('content.objects', { handle: 'h1', page: 0 });
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 7 });
    const warnings = store.getState().visible.filter((x) => x.kind === 'warning');
    expect(warnings.map((x) => x.text)).toEqual([t('edit.stale')]);
  });

  it('leaves the document alone when the engine refuses for another reason', async () => {
    const { store, deps, settle, noteRevisions } = setup({
      run: () => {
        throw new RpcError('BUSY', 'busy');
      },
    });
    await commitEdit(deps, { kind: 'delete', page: 0, revision: 4, objects: [photo] }, settle);
    expect(settle).not.toHaveBeenCalled();
    expect(noteRevisions).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(1);
  });
});

describe('committing a replace', () => {
  const file = () =>
    new File([new Uint8Array([137, 80, 78, 71, 1, 2])], 'p.png', { type: 'image/png' });

  it('sends content.replace_image with the picture ref and the file bytes', async () => {
    const { call, deps, settle } = setup({ objects: [photo] });
    await commitEdit(
      deps,
      { kind: 'replace', page: 0, revision: 4, objects: [photo], file: file() },
      settle,
    );
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.replace_image',
      args: { object: { page: 0, key: 'img1', revision: 4 }, data: expect.any(ArrayBuffer) },
    });
    const [, params] = call.mock.calls[0] as unknown as [string, { args: { data: ArrayBuffer } }];
    expect(new Uint8Array(params.args.data)).toEqual(new Uint8Array([137, 80, 78, 71, 1, 2]));
  });

  it('offers Undo with the replace message and keeps the picture selected at its box', async () => {
    const { store, deps, settle } = setup({ revision: 5, objects: [photo] });
    await commitEdit(
      deps,
      { kind: 'replace', page: 0, revision: 4, objects: [photo], file: file() },
      settle,
    );
    await flush();
    const [toast] = store.getState().visible;
    expect(toast?.text).toBe(t('edit.image.replaced'));
    expect(toast?.action?.label).toBe(t('toast.undo'));
    expect(settle).toHaveBeenLastCalledWith({ page: 0, revision: 5, keys: ['img1'] });
  });

  it('a refused replace shows its message and keeps the selection', async () => {
    const { store, deps, settle } = setup({
      run: () => {
        throw new RpcError('REFUSED', 'stored inside', { reason: 'inline_image' });
      },
    });
    await commitEdit(
      deps,
      { kind: 'replace', page: 0, revision: 4, objects: [photo], file: file() },
      settle,
    );
    expect(store.getState().visible[0]?.text).toBe(t('error.REFUSED.inlineImage'));
    expect(settle).not.toHaveBeenCalled();
  });
});
