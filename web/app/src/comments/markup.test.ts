import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { mapRpcError } from '../rpc/errors';
import { domSelectionAreas, type ModelRead } from '../text/selection';
import type { PageArea } from '../text/textLayer';
import { MARKUP_COMMAND_KINDS, markSelection, type MarkupDeps, pressMarkup } from './markup';

vi.mock('../text/selection', () => ({ domSelectionAreas: vi.fn(() => [] as PageArea[]) }));

const AREA: PageArea = {
  page: 2,
  rect: { x0: 1, y0: 10, x1: 21, y1: 22 },
  quads: [{ ul: { x: 1, y: 10 }, ur: { x: 21, y: 10 }, ll: { x: 1, y: 22 }, lr: { x: 21, y: 22 } }],
  text: 'jane',
};

function setup(overrides: Partial<MarkupDeps> = {}, executed = true) {
  const call = vi.fn<(method: string, args?: unknown) => Promise<unknown>>(async () => ({
    label: 'Highlight',
    executed,
    value: null,
    changed: { changes: [], revisions: { '2': 5 } },
    state: { history: 9 },
  }));
  const noteRevisions = vi.fn();
  const clearModel = vi.fn();
  const store = createToastStore();
  const model: ModelRead<PageArea[]> = { state: 'ready', value: [AREA] };
  const deps: MarkupDeps = {
    rpc: { call } as unknown as PageRpc,
    handle: 'h1',
    scheduler: { noteRevisions },
    pageSpan: () => 1,
    model: () => model,
    clearModel,
    loadPages: vi.fn(async () => undefined),
    selection: null,
    lookup: () => undefined,
    store,
    ...overrides,
  };
  return { call, noteRevisions, clearModel, store, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(domSelectionAreas).mockReturnValue([]);
});

describe('text markup from the selection (W7.1a slice 5)', () => {
  it('runs annotations.mark_text with each page share, its lines and text', async () => {
    const { call, deps } = setup();
    expect(await markSelection('underline', deps)).toBe('marked');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.mark_text',
      args: {
        kind: 'underline',
        areas: [{ page: 2, text: 'jane', quads: AREA.quads }],
        author: '',
      },
    });
  });

  it('clears the model selection and the notes the revisions once marked', async () => {
    const { noteRevisions, clearModel, deps } = setup();
    await markSelection('highlight', deps);
    expect(clearModel).toHaveBeenCalledOnce();
    expect(noteRevisions).toHaveBeenCalledWith({ '2': 5 });
  });

  it('reads the browser selection under Hand, and clears that one', async () => {
    const dom: PageArea = { ...AREA, text: 'dom' };
    vi.mocked(domSelectionAreas).mockReturnValue([dom]);
    const native = { removeAllRanges: vi.fn() } as unknown as Selection;
    const { call, clearModel, deps } = setup({
      model: () => ({ state: 'off' }),
      selection: native,
    });
    expect(await markSelection('strikeout', deps)).toBe('marked');
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      args: { areas: [{ page: 2, text: 'dom' }] },
    });
    expect(clearModel).not.toHaveBeenCalled();
    expect(native.removeAllRanges).toHaveBeenCalledOnce();
  });

  it('does nothing with no text selected', async () => {
    const { call, deps } = setup({ model: () => ({ state: 'ready', value: [] }) });
    expect(await markSelection('highlight', deps)).toBe('none');
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a selection over more pages than the text layers allow', async () => {
    const { call, store, deps } = setup({ pageSpan: () => 301 });
    expect(await markSelection('highlight', deps)).toBe('busy');
    expect(call).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.text).toBe(t('markup.selectionTooLarge'));
  });

  it('waits for the pages of a loading selection, then gives up if they are still loading', async () => {
    const loadPages = vi.fn(async () => undefined);
    const { store, deps } = setup({
      model: () => ({ state: 'loading', pages: [0] }),
      loadPages,
    });
    expect(await markSelection('squiggly', deps)).toBe('busy');
    expect(loadPages).toHaveBeenCalledWith([0]);
    expect(store.getState().visible[0]?.text).toBe(t('text.stillLoading'));
  });

  it('tells the user when the engine refuses the markup', async () => {
    const { store, deps } = setup({
      rpc: { call: vi.fn(async () => Promise.reject(new Error('boom'))) } as unknown as PageRpc,
    });
    expect(await markSelection('highlight', deps)).toBe('failed');
    expect(store.getState().visible[0]?.text).toBe(t('comment.failed'));
  });

  it('shows the RPC error text when the call rejects with an RpcError', async () => {
    const error = new RpcError('INTERNAL', 'engine broke');
    const { store, clearModel, deps } = setup({
      rpc: { call: vi.fn(async () => Promise.reject(error)) } as unknown as PageRpc,
    });
    expect(await markSelection('highlight', deps)).toBe('failed');
    const presentation = mapRpcError(error);
    expect(store.getState().visible[0]?.text).toBe(t(presentation.messageId, presentation.params));
    expect(clearModel).not.toHaveBeenCalled();
  });

  it('keeps the selection when the markup fails', async () => {
    const { clearModel, deps } = setup({
      rpc: { call: vi.fn(async () => Promise.reject(new Error('boom'))) } as unknown as PageRpc,
    });
    await markSelection('highlight', deps);
    expect(clearModel).not.toHaveBeenCalled();
  });

  it('reports an engine that executes no step as a failure, not as no selection', async () => {
    const { store, noteRevisions, clearModel, deps } = setup({}, false);
    expect(await markSelection('highlight', deps)).toBe('unmarked');
    expect(noteRevisions).not.toHaveBeenCalled();
    expect(clearModel).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.text).toBe(t('comment.failed'));
  });
});

describe('the ribbon markup commands', () => {
  it('map strikethrough to the engine kind strikeout, and the others to their own', () => {
    expect(MARKUP_COMMAND_KINDS).toEqual({
      highlight: 'highlight',
      underline: 'underline',
      strikethrough: 'strikeout',
      squiggly: 'squiggly',
    });
  });
});

describe('a markup button press', () => {
  it('runs the drag tool for Highlight with no selection', async () => {
    const noSelection = vi.fn();
    const { deps } = setup({ model: () => ({ state: 'ready', value: [] }) });
    await pressMarkup('highlight', deps, noSelection);
    expect(noSelection).toHaveBeenCalledOnce();
  });

  it('asks for a selection with no selection for the other markups', async () => {
    const noSelection = vi.fn();
    const { store, deps } = setup({ model: () => ({ state: 'ready', value: [] }) });
    await pressMarkup('squiggly', deps, noSelection);
    expect(noSelection).not.toHaveBeenCalled();
    expect(store.getState().visible[0]?.text).toBe(t('markup.selectTextFirst'));
  });

  it('does not run the drag tool once a selection was marked', async () => {
    const noSelection = vi.fn();
    const { deps } = setup();
    await pressMarkup('highlight', deps, noSelection);
    expect(noSelection).not.toHaveBeenCalled();
  });

  it('with text selected but no step executed, says nothing about selection and turns no tool on', async () => {
    const noSelection = vi.fn();
    const { store, deps } = setup({}, false);
    await pressMarkup('highlight', deps, noSelection);
    const texts = store.getState().visible.map((toast) => toast.text);
    expect(texts).not.toContain(t('markup.selectTextFirst'));
    expect(texts).toEqual([t('comment.failed')]);
    expect(noSelection).not.toHaveBeenCalled();
  });
});
