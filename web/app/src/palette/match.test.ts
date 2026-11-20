import { describe, expect, it } from 'vitest';
import type { MessageId } from '../i18n/en';
import { GROUPS } from '../commands/catalog';
import { type CommandDef, type CommandState, createRegistry } from '../commands/registry';
import { normalize, rankCommands, scoreLabel } from './match';

function state(overrides: Partial<CommandState> = {}): CommandState {
  return {
    hasDocument: true,
    hasRecentFiles: false,
    canUndo: false,
    canRedo: false,
    capabilities: new Set(),
    ribbonCompact: false,
    ribbonCollapsed: false,
    viewTool: 'select',
    canGoBack: false,
    canGoForward: false,
    view: null,
    ...overrides,
  };
}

function def(id: string, labelId: MessageId, extra: Partial<CommandDef> = {}): CommandDef {
  return { id, labelId, group: 'home.file', enabled: () => null, ...extra };
}

function registryOf(...defs: CommandDef[]) {
  return createRegistry(defs, GROUPS, []);
}

function ids(matches: { def: CommandDef }[]): string[] {
  return matches.map((match) => match.def.id);
}

describe('normalize', () => {
  it('removes accents and lower-cases', () => {
    expect(normalize('Éclair Café')).toBe('eclair cafe');
  });

  it('turns the ellipsis, ampersand and punctuation into word breaks', () => {
    expect(normalize('Open…')).toBe('open');
    expect(normalize('Fish & Chips')).toBe('fish chips');
    expect(normalize('Save as PDF/A')).toBe('save as pdf a');
    expect(normalize('  Save   As  ')).toBe('save as');
  });
});

describe('scoreLabel tiers', () => {
  it('ranks a word start above a substring, above initials, above letters in order', () => {
    const label = 'Reduce File Size';
    const wordStart = scoreLabel(label, 'red');
    const substring = scoreLabel(label, 'ile');
    const initials = scoreLabel(label, 'rfs');
    const inOrder = scoreLabel(label, 'rds');
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(initials);
    expect(initials).toBeGreaterThan(inOrder);
    expect(inOrder).toBeGreaterThan(0);
  });

  it('finds initials, so "rfs" finds Reduce File Size', () => {
    expect(scoreLabel('Reduce File Size', 'rfs')).toBe(2);
    expect(scoreLabel('Reduce File Size', 'rf')).toBe(2);
  });

  it('matches letters in order only when the first letter starts a word', () => {
    expect(scoreLabel('Reduce File Size', 'dfs')).toBe(0);
    expect(scoreLabel('Reduce File Size', 'rds')).toBe(1);
  });

  it('never matches a one- or two-letter word as letters in order', () => {
    // r and s are in order in "Reduce File Size", but a 2-letter word is not a subsequence match.
    expect(scoreLabel('Reduce File Size', 'rs')).toBe(0);
    expect(scoreLabel('Reduce File Size', 'q')).toBe(0);
  });
});

describe('rankCommands', () => {
  const reduce = def('reduce-file-size', 'command.reduce-file-size.label');
  const save = def('save', 'command.save.label');
  const saveAs = def('save-as-pdf-a', 'command.save-as-pdf-a.label');

  it('requires every query word to match the label', () => {
    const registry = registryOf(save, saveAs);
    expect(rankCommands(registry, state(), 'save zzz', [])).toEqual([]);
    expect(ids(rankCommands(registry, state(), 'save pdf', []))).toEqual(['save-as-pdf-a']);
  });

  it('finds Reduce File Size from its initials', () => {
    const registry = registryOf(save, reduce);
    expect(ids(rankCommands(registry, state(), 'rfs', []))).toEqual(['reduce-file-size']);
  });

  it('puts a label that starts with the whole query ahead of a later word hit', () => {
    const redact = def('redact', 'command.redact.label');
    const openRecent = def('open-recent', 'command.open-recent.label');
    const registry = registryOf(openRecent, redact);
    expect(ids(rankCommands(registry, state(), 're', []))).toEqual(['redact', 'open-recent']);
  });

  it('keeps registry order for a tie, with "Save" before "Save as PDF/A"', () => {
    const registry = registryOf(save, saveAs);
    expect(ids(rankCommands(registry, state(), 'save', []))).toEqual(['save', 'save-as-pdf-a']);
  });

  it('matches keywords, but a keyword hit ranks below an equal label hit', () => {
    const removeSecurity = def('remove-security', 'command.remove-security.label');
    const deletePages = def('delete-pages', 'command.delete-pages.label', {
      keywordsId: 'command.delete-pages.keywords',
    });
    const registry = registryOf(deletePages, removeSecurity);
    expect(ids(rankCommands(registry, state(), 'remove', []))).toEqual([
      'remove-security',
      'delete-pages',
    ]);
    expect(ids(rankCommands(registry, state(), 'merge', []))).toEqual([]);
  });

  it('finds a command by a keyword alias from the catalogue', () => {
    const sanitize = def('sanitize-document', 'command.sanitize-document.label', {
      keywordsId: 'command.sanitize-document.keywords',
    });
    const registry = registryOf(sanitize);
    expect(ids(rankCommands(registry, state(), 'clean', []))).toEqual(['sanitize-document']);
    expect(ids(rankCommands(registry, state(), 'metadata', []))).toEqual(['sanitize-document']);
  });

  it('never returns a hidden command, and returns it once its capability is on', () => {
    const ocr = def('recognize-text-ocr', 'command.recognize-text-ocr.label', {
      capability: 'ocr',
    });
    const registry = registryOf(ocr);
    expect(rankCommands(registry, state(), 'ocr', [])).toEqual([]);
    expect(
      ids(rankCommands(registry, state({ capabilities: new Set(['ocr']) }), 'ocr', [])),
    ).toEqual(['recognize-text-ocr']);
  });

  it('returns a disabled command too, so the caller can show the reason', () => {
    const disabled = def('save', 'command.save.label', { enabled: () => 'needsDocument' });
    const registry = registryOf(disabled);
    const [match] = rankCommands(registry, state(), 'save', []);
    expect(match?.def.id).toBe('save');
    expect(match?.def.enabled(state())).toBe('needsDocument');
  });

  it('puts a recent command first among equal scores', () => {
    const registry = registryOf(save, saveAs);
    const matches = rankCommands(registry, state(), 'save', ['save-as-pdf-a']);
    expect(ids(matches)).toEqual(['save-as-pdf-a', 'save']);
    expect(matches.map((match) => match.recentRank)).toEqual([0, Infinity]);
  });

  it('lists recent commands first, in recency order, with no duplicates, for an empty query', () => {
    const registry = registryOf(
      def('a', 'command.open.label'),
      def('b', 'command.save.label'),
      def('c', 'command.print.label'),
      def('d', 'command.undo.label'),
    );
    const matches = rankCommands(registry, state(), '', ['c', 'a', 'zz-unknown']);
    expect(ids(matches)).toEqual(['c', 'a', 'b', 'd']);
    expect(matches.every((match) => match.score === 0)).toBe(true);
    expect(new Set(ids(matches)).size).toBe(matches.length);
  });

  it('returns every visible command for an empty query, with a score of 0', () => {
    const registry = registryOf(save, saveAs, reduce);
    expect(ids(rankCommands(registry, state(), '   ', []))).toEqual([
      'save',
      'save-as-pdf-a',
      'reduce-file-size',
    ]);
  });
});
