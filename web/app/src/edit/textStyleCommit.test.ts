// The style the paragraph editor's bar sets reaches the engine with the text (W6.8b slice 1), and the
// substitution notice names what the engine reports (design section 5.1, rows 2 and 3).
import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { PageObjectDto, RectDto, RunResult } from '../rpc/generated';
import { type CommitDeps, commitAdd, commitText, type SettledSelection } from './commit';
import { ObjectCache } from './objectCache';
import { DEFAULT_TEXT_ARG, DEFAULT_TEXT_STYLE, toActionStyle } from './textStyle';

const box = (x0: number, y0: number, x1: number, y1: number): RectDto => ({ x0, y0, x1, y1 });

const paragraph: PageObjectDto = {
  type: 'text',
  key: 'text:3',
  bbox: box(72, 72, 300, 120),
  text: 'Old words',
  style: { ...DEFAULT_TEXT_STYLE, font: 'ABCDEF+Arial' },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
};

function reply(value: unknown = null): RunResult {
  return {
    label: 'Edit Text',
    executed: true,
    value,
    changed: { changes: [], revisions: { '0': 5 } },
    state: { history: 9 },
  } as unknown as RunResult;
}

function setup(value: unknown = null) {
  const call = vi.fn(async (method: string) => {
    if (method === 'actions.run') return reply(value);
    if (method === 'content.objects') {
      return { revision: 5, objects: [paragraph], truncated: false };
    }
    return { done: true, label: 'Edit Text', changed: null, state: { history: 8 } };
  });
  const rpc = { call } as unknown as PageRpc;
  const store = createToastStore();
  const cache = new ObjectCache(rpc as never, 'h1');
  const deps: CommitDeps = {
    rpc,
    handle: 'h1',
    cache,
    scheduler: { noteRevisions: vi.fn() },
    store,
  };
  const settle = vi.fn<(selection: SettledSelection | null) => void>();
  const sent = () =>
    (call.mock.calls as unknown as [string, { args?: { style?: unknown } }][]).find(
      ([method]) => method === 'actions.run',
    )?.[1];
  const styleSent = () => sent()?.args?.style;
  return { call, deps, settle, store, sent, styleSent };
}

const texts = (store: ReturnType<typeof createToastStore>) =>
  store.getState().visible.map((toast) => toast.text);

describe('committing the style with the text', () => {
  it('sends the bar style in the replace_text args', async () => {
    const style = toActionStyle({ ...paragraph.style!, bold: true, size: 14 });
    const { deps, settle, sent } = setup();
    await commitText(
      deps,
      { page: 0, revision: 4, object: paragraph, text: 'New words', style },
      settle,
    );
    expect(sent()).toEqual({
      handle: 'h1',
      name: 'content.replace_text',
      args: {
        object: { page: 0, key: 'text:3', revision: 4 },
        text: 'New words',
        style,
      },
    });
  });

  it('sends null when the style did not change', async () => {
    const { deps, settle, styleSent } = setup();
    await commitText(deps, { page: 0, revision: 4, object: paragraph, text: 'x' }, settle);
    expect(styleSent()).toBeNull();
  });

  it('sends the bar style for a new block, and the default when there is none', async () => {
    const style = toActionStyle({ ...DEFAULT_TEXT_STYLE, italic: true });
    const first = setup();
    await commitAdd(first.deps, { page: 0, rect: box(1, 2, 3, 4), text: 'Hi', style });
    expect(first.styleSent()).toEqual(style);
    const second = setup();
    await commitAdd(second.deps, { page: 0, rect: box(1, 2, 3, 4), text: 'Hi' });
    expect(second.styleSent()).toEqual(DEFAULT_TEXT_ARG);
  });
});

describe('the substitution notice', () => {
  const change = (style?: ReturnType<typeof toActionStyle>) => ({
    page: 0,
    revision: 4,
    object: paragraph,
    text: 'New words',
    ...(style === undefined ? {} : { style }),
  });

  it('names the font used and the missing characters when another font was used', async () => {
    const value = { name: 'Helvetica', embedded_reused: false, substituted: true, missing: 'Ü€' };
    const { deps, settle, store } = setup(value);
    await commitText(deps, change(), settle);
    expect(texts(store)).toEqual([
      `${t('edit.text.substituted', { name: 'Helvetica' })} ${t('edit.text.missing', { chars: 'Ü€' })}`,
    ]);
  });

  it('says the font could not be reused when the engine lists no characters', async () => {
    const value = { name: 'Helvetica', embedded_reused: false, substituted: true, missing: '' };
    const { deps, settle, store } = setup(value);
    await commitText(deps, change(), settle);
    expect(texts(store)).toEqual([
      t('edit.font.notReused', { font: 'ABCDEF+Arial', used: 'Helvetica' }),
    ]);
  });

  it('shows the count of the characters beyond the first 20', async () => {
    const missing = 'ЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬ';
    const value = { name: 'ABCDEF+Arial', embedded_reused: false, substituted: true, missing };
    const { deps, settle, store } = setup(value);
    const styled = toActionStyle({ ...paragraph.style!, font: 'ABCDEF+Arial' });
    await commitText(deps, change(styled), settle);
    expect(texts(store)).toEqual([
      t('edit.font.missingGlyphs', {
        font: 'ABCDEF+Arial',
        chars: `${missing.slice(0, 20)} ${t('edit.font.moreChars', { count: 3 })}`,
      }),
    ]);
  });

  it('shows no warning when the font was reused', async () => {
    const value = { name: 'ABCDEF+Arial', embedded_reused: true, substituted: false, missing: '' };
    const { deps, settle, store } = setup(value);
    await commitText(deps, change(), settle);
    expect(texts(store)).toEqual([t('edit.textEdited')]);
  });
});
