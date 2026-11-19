import { describe, expect, it } from 'vitest';
import { decodeEvents } from './events';
import { newDecodeContext, ReplyShapeError } from './shape';

const DOC_STATE = {
  page_count: 1,
  structure_version: 0,
  dirty: false,
  busy: '',
  can_undo: false,
  can_redo: false,
  undo_label: '',
  redo_label: '',
  require_full_save: false,
};

function decode(events: unknown): unknown {
  return decodeEvents(events, newDecodeContext([]), 'reply.events');
}

describe('decodeEvents', () => {
  it('decodes an empty list to an empty list', () => {
    expect(decode([])).toEqual([]);
  });

  it('decodes each kind and keeps its kind, in order', () => {
    const events = [
      {
        kind: 'changed',
        handle: 'h',
        changes: [{ kind: 'content', pages: [0] }],
        revisions: { '0': 7 },
      },
      { kind: 'blocked', handle: 'h', task: 'Sanitize Document' },
      { kind: 'saved', handle: 'h' },
      { kind: 'closed', handle: 'h' },
      { kind: 'state', handle: 'h', state: DOC_STATE },
    ];
    expect(decode(events)).toEqual(events);
  });

  it('rejects an unknown kind, naming the event', () => {
    expect(() => decode([{ kind: 'dirty', handle: 'h' }])).toThrow(ReplyShapeError);
    expect(() => decode([{ kind: 'dirty', handle: 'h' }])).toThrow('reply.events[0].kind');
  });

  it('rejects an event without a kind', () => {
    expect(() => decode([{ handle: 'h' }])).toThrow('reply.events[0]');
  });

  it('rejects an extra key on an event', () => {
    expect(() => decode([{ kind: 'saved', handle: 'h', extra: 1 }])).toThrow(ReplyShapeError);
  });

  it('rejects an event without its handle', () => {
    expect(() => decode([{ kind: 'closed' }])).toThrow('reply.events[0].handle');
  });

  it('rejects a field of the wrong type inside a state event', () => {
    const state = { ...DOC_STATE, dirty: 'yes' };
    expect(() => decode([{ kind: 'state', handle: 'h', state }])).toThrow(
      'reply.events[0].state.dirty',
    );
  });

  it('rejects a list that is not an array', () => {
    expect(() => decode({ kind: 'saved', handle: 'h' })).toThrow('reply.events');
  });
});
