import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../commands/catalog';
import type { CommandState } from '../commands/registry';
import { OVERLAY_TEXT_MAX_LENGTH } from '../prefs/store';
import { applyStylePatch, draftFromPreferences, preferencesFromDraft } from './redactionProperties';

const style = {
  redactionFill: '#ff8000',
  redactionOverlayText: 'EXEMPT',
  redactionTextColor: '#00ff7f',
};

describe('draftFromPreferences', () => {
  it('reads the stored style into colours and text', () => {
    const draft = draftFromPreferences(style);
    expect(draft.fill).toEqual({ r: 1, g: 0.502, b: 0 });
    expect(draft.textColor).toEqual({ r: 0, g: 1, b: 0.498 });
    expect(draft.overlayText).toBe('EXEMPT');
  });

  it('falls back to the defaults for a bad colour and cleans the text', () => {
    const draft = draftFromPreferences({
      redactionFill: 'red',
      redactionOverlayText: ' a\u0007b ',
      redactionTextColor: '#FFF',
    });
    expect(draft.fill).toEqual({ r: 0, g: 0, b: 0 });
    expect(draft.textColor).toEqual({ r: 1, g: 1, b: 1 });
    expect(draft.overlayText).toBe('ab');
  });
});

describe('applyStylePatch', () => {
  const draft = draftFromPreferences(style);

  it('changes only the field the patch sets', () => {
    const next = applyStylePatch(draft, { overlayText: 'NEW' });
    expect(next.overlayText).toBe('NEW');
    expect(next.fill).toEqual(draft.fill);
    expect(next.textColor).toEqual(draft.textColor);
  });

  it('cuts an overlay text longer than the preferences limit', () => {
    const long = 'x'.repeat(OVERLAY_TEXT_MAX_LENGTH + 36);
    expect(applyStylePatch(draft, { overlayText: long }).overlayText).toHaveLength(
      OVERLAY_TEXT_MAX_LENGTH,
    );
  });
});

describe('preferencesFromDraft', () => {
  it('writes the three style keys as #rrggbb and round-trips each colour', () => {
    const hexes = ['#000000', '#ffffff', '#ff8000', '#0a0b0c', '#7f80ff'];
    for (const hex of hexes) {
      const keys = preferencesFromDraft(draftFromPreferences({ ...style, redactionFill: hex }));
      expect(keys.redactionFill).toBe(hex);
    }
    expect(preferencesFromDraft(draftFromPreferences(style))).toEqual({
      redactionFill: '#ff8000',
      redactionTextColor: '#00ff7f',
      redactionOverlayText: 'EXEMPT',
    });
  });
});

describe('Redaction Properties command', () => {
  // The dialog needs no document: the command is enabled in the empty state.
  const empty: CommandState = {
    hasDocument: false,
    hasRecentFiles: false,
    canUndo: false,
    canRedo: false,
    capabilities: new Set(),
    ribbonCompact: false,
    ribbonCollapsed: false,
    viewTool: 'select',
    commentTool: null,
    redacting: false,
    canApplyRedactions: false,
  };

  it('is enabled with no document open', () => {
    const command = COMMANDS.find((c) => c.id === 'redaction-properties');
    expect(command?.enabled(empty)).toBeNull();
  });
});
