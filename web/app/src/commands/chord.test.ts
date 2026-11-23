import { describe, expect, it } from 'vitest';
import { type RecordedKeyEvent, chordFromKeyEvent } from './chord';

function keyEvent(init: Partial<RecordedKeyEvent> & { key: string }): RecordedKeyEvent {
  return { code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init };
}

describe('chordFromKeyEvent', () => {
  it('ignores a modifier or lock key pressed alone, so recording goes on', () => {
    for (const name of [
      'CapsLock',
      'NumLock',
      'ScrollLock',
      'Fn',
      'FnLock',
      'Super',
      'Hyper',
      'Symbol',
      'SymbolLock',
    ]) {
      expect(chordFromKeyEvent(keyEvent({ key: name, code: name }), false), name).toBeUndefined();
    }
  });

  it('records Space under the table name, with its modifiers', () => {
    expect(chordFromKeyEvent(keyEvent({ key: ' ', code: 'Space', ctrlKey: true }), false)).toEqual({
      kind: 'chord',
      text: 'Ctrl+Space',
    });
  });
});
