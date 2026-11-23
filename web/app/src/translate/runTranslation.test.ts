import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '../rpc/client';
import type { PageArea } from '../text/textLayer';
import {
  addTranslationNote,
  defaultLanguages,
  MAX_TRANSLATE_CHARS,
  readSelection,
  runTranslation,
} from './runTranslation';

const AREA: PageArea = {
  page: 0,
  rect: { x0: 10, y0: 20, x1: 110, y1: 40 },
  quads: [
    {
      ul: { x: 10, y: 20 },
      ur: { x: 110, y: 20 },
      ll: { x: 10, y: 40 },
      lr: { x: 110, y: 40 },
    },
  ],
  text: 'Hello world',
};

describe('defaultLanguages', () => {
  it('starts From at the last source, else English, and never offers a detect entry', () => {
    const codes = ['de', 'en', 'fr'];
    expect(defaultLanguages(codes, { translationLastSource: 'fr', translationTarget: '' })).toEqual(
      {
        source: 'fr',
        target: 'en',
      },
    );
    expect(defaultLanguages(codes, { translationLastSource: '', translationTarget: '' })).toEqual({
      source: 'en',
      target: 'de',
    });
  });

  it('takes To from the saved target, and skips a target equal to From', () => {
    const codes = ['de', 'en', 'fr'];
    expect(
      defaultLanguages(codes, { translationLastSource: 'en', translationTarget: 'fr' }),
    ).toEqual({ source: 'en', target: 'fr' });
    expect(
      defaultLanguages(codes, { translationLastSource: 'de', translationTarget: 'de' }),
    ).toEqual({ source: 'de', target: 'en' });
  });

  it('ignores codes MyMemory does not list', () => {
    expect(
      defaultLanguages(['fr'], { translationLastSource: 'xx', translationTarget: 'yy' }),
    ).toEqual({ source: 'fr', target: '' });
  });
});

describe('runTranslation', () => {
  it('refuses a text over the cap before any call', async () => {
    const call = vi.fn();
    const outcome = await runTranslation(call, {
      text: 'a'.repeat(MAX_TRANSLATE_CHARS + 1),
      source: 'en',
      target: 'fr',
    });
    expect(call).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'TRANSLATION_TOO_LONG' } });
  });

  it('sends nothing while the browser is offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const call = vi.fn();
    const outcome = await runTranslation(call, { text: 'Hi', source: 'en', target: 'fr' });
    online.mockRestore();
    expect(call).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'failed', error: { code: 'TRANSLATION_OFFLINE' } });
  });

  it('sends only the text and the two codes, and returns the translation', async () => {
    const call = vi
      .fn()
      .mockResolvedValue({ text: 'Bonjour', detected: null, service: 'mymemory' });
    const outcome = await runTranslation(call, { text: 'Hello', source: 'en', target: 'fr' });
    expect(call).toHaveBeenCalledWith({ text: 'Hello', source: 'en', target: 'fr' });
    expect(outcome).toEqual({ kind: 'done', text: 'Bonjour' });
  });

  it('keeps the partial text of a call that stopped part way', async () => {
    const error = new RpcError('TRANSLATION_OFFLINE', 'offline', { partial: 'Bonjour' });
    const outcome = await runTranslation(vi.fn().mockRejectedValue(error), {
      text: 'Hello. More.',
      source: 'en',
      target: 'fr',
    });
    expect(outcome).toEqual({ kind: 'failed', error, partial: 'Bonjour' });
  });
});

describe('readSelection', () => {
  it('reads the model selection first, and gives null when there is no text', () => {
    const snapshot = readSelection(
      () => ({ state: 'ready', value: [AREA] }),
      null,
      () => undefined,
    );
    expect(snapshot).toEqual({ text: 'Hello world', areas: [AREA] });
    expect(
      readSelection(
        () => ({ state: 'off' }),
        null,
        () => undefined,
      ),
    ).toBeNull();
  });
});

describe('addTranslationNote', () => {
  it('sends one highlight per page, one rectangle per line, with the translation as the note', async () => {
    const call = vi.fn().mockResolvedValue({
      executed: false,
      changed: undefined,
      state: { history: {} },
    });
    const noteRevisions = vi.fn();
    await addTranslationNote(
      {
        rpc: { call } as never,
        handle: 'h1',
        scheduler: { noteRevisions },
        store: { push: vi.fn() } as never,
      },
      [AREA],
      'Bonjour',
    );
    expect(call).toHaveBeenCalledWith(
      'actions.run',
      expect.objectContaining({
        handle: 'h1',
        name: 'annotations.highlight_text',
        args: {
          pages: [{ page: 0, rects: [{ x0: 10, y0: 20, x1: 110, y1: 40 }] }],
          note: 'Bonjour',
          author: '',
        },
      }),
    );
    expect(noteRevisions).not.toHaveBeenCalled();
  });
});
