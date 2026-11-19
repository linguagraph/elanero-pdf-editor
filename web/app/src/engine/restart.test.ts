import { describe, expect, it, vi } from 'vitest';
import { LOST_WORK, type OpenDocumentRef, restartEngine } from './restart';

const DOCS: OpenDocumentRef[] = [
  { id: 'd1', name: 'contract.pdf' },
  { id: 'd2', name: 'notes.pdf' },
  { id: 'd3', name: 'scan.pdf' },
];

describe('restartEngine', () => {
  it('asks the engine owner to replace the engine once', () => {
    const replaceEngine = vi.fn(() => true);

    const result = restartEngine({ replaceEngine, documents: DOCS });

    expect(replaceEngine).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it('reports what is lost: the changes since the last autosave and the undo history', () => {
    const result = restartEngine({ replaceEngine: () => true, documents: DOCS });

    if (!result.ok) throw new Error('the restart should have started');
    expect(result.lost).toBe(LOST_WORK);
    expect(result.lost.text).toContain('since the last autosave');
    expect(result.lost.text).toContain('undo history');
    expect(result.lost.items).toEqual([
      'the changes made since the last autosave',
      'the undo history',
    ]);
  });

  it('lists the documents to reopen in the order the caller gave', () => {
    const result = restartEngine({ replaceEngine: () => true, documents: DOCS });

    if (!result.ok) throw new Error('the restart should have started');
    expect(result.reopen).toEqual(DOCS);
    expect(result.reopen.map((doc) => doc.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('lists no documents when none were open', () => {
    const result = restartEngine({ replaceEngine: () => true, documents: [] });

    if (!result.ok) throw new Error('the restart should have started');
    expect(result.reopen).toEqual([]);
  });

  it('returns a typed error when the new engine cannot start', () => {
    const result = restartEngine({ replaceEngine: () => false, documents: DOCS });

    expect(result).toEqual({ ok: false, code: 'ENGINE_START_FAILED' });
  });
});
