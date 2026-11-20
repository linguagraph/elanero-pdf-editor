import { describe, expect, it } from 'vitest';
import {
  activateTab,
  addTab,
  applyDocState,
  closeTab,
  EMPTY_TABS,
  hasDirtyTab,
  neighbourTabId,
  renameTab,
  replaceHandle,
  setDirty,
  setPageCount,
  type TabDocState,
  type TabState,
} from './tabState';

const pdf = (name: string) => ({ name, handle: `handle-${name}`, pages: 1 });

function withThree(): TabState {
  let state = addTab(EMPTY_TABS, pdf('a.pdf'));
  state = addTab(state, pdf('b.pdf'));
  return addTab(state, pdf('c.pdf'));
}

describe('tab state', () => {
  it('adds a tab at the end and makes it active', () => {
    const state = addTab(EMPTY_TABS, pdf('a.pdf'));
    expect(state.tabs.map((tab) => tab.name)).toEqual(['a.pdf']);
    expect(state.activeId).toBe(state.tabs[0]?.id);
    expect(state.tabs[0]?.dirty).toBe(false);
    expect(state.tabs[0]?.handle).toBe('handle-a.pdf');
    expect(state.tabs[0]?.pages).toBe(1);
  });

  it('gives every tab its own id, even after a close', () => {
    const state = closeTab(withThree(), 2);
    const added = addTab(state, pdf('d.pdf'));
    const ids = added.tabs.map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('closes a tab that is not active without changing the active one', () => {
    const state = closeTab(activateTab(withThree(), 1), 3);
    expect(state.tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(state.activeId).toBe(1);
  });

  it('activates the next tab when the active one closes', () => {
    const state = closeTab(activateTab(withThree(), 2), 2);
    expect(state.tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'c.pdf']);
    expect(state.activeId).toBe(3);
  });

  it('activates the previous tab when the last one closes', () => {
    const state = closeTab(withThree(), 3);
    expect(state.activeId).toBe(2);
  });

  it('has no active tab once the last tab closes', () => {
    const state = closeTab(addTab(EMPTY_TABS, pdf('a.pdf')), 1);
    expect(state.tabs).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  it('ignores activating or closing an id that is not open', () => {
    const state = withThree();
    expect(activateTab(state, 99)).toBe(state);
    expect(closeTab(state, 99)).toBe(state);
  });

  it('marks a tab dirty and reports it', () => {
    const state = setDirty(withThree(), 2, true);
    expect(state.tabs.find((tab) => tab.id === 2)?.dirty).toBe(true);
    expect(hasDirtyTab(state)).toBe(true);
    expect(hasDirtyTab(setDirty(state, 2, false))).toBe(false);
  });

  it('sets the page count of one tab and leaves the others alone', () => {
    const state = setPageCount(withThree(), 2, 7);
    expect(state.tabs.map((tab) => tab.pages)).toEqual([1, 7, 1]);
    expect(state.activeId).toBe(3);
  });
});

describe('neighbourTabId (Next and Previous Document, W4.3b)', () => {
  it('steps to the next and previous tab from the active one', () => {
    const state = activateTab(withThree(), 2);
    expect(neighbourTabId(state, 1)).toBe(3);
    expect(neighbourTabId(state, -1)).toBe(1);
  });

  it('wraps from the last tab to the first, and from the first to the last', () => {
    const last = activateTab(withThree(), 3);
    expect(neighbourTabId(last, 1)).toBe(1);
    const first = activateTab(withThree(), 1);
    expect(neighbourTabId(first, -1)).toBe(3);
  });

  it('lands on the only tab in either direction', () => {
    const one = addTab(EMPTY_TABS, pdf('a.pdf'));
    expect(neighbourTabId(one, 1)).toBe(1);
    expect(neighbourTabId(one, -1)).toBe(1);
  });

  it('starts at the first tab for Next and the last for Previous when none is active', () => {
    const none = { ...withThree(), activeId: null };
    expect(neighbourTabId(none, 1)).toBe(1);
    expect(neighbourTabId(none, -1)).toBe(3);
  });

  it('returns null with no tabs', () => {
    expect(neighbourTabId(EMPTY_TABS, 1)).toBeNull();
  });
});

describe('replaceHandle (W3.9 restart)', () => {
  it('points the tab at the reopened document and marks it dirty again', () => {
    const state = setDirty(withThree(), 2, false);

    const next = replaceHandle(state, 2, 'handle-new', 7);

    expect(next.tabs[1]).toMatchObject({ id: 2, handle: 'handle-new', pages: 7, dirty: true });
    expect(next.tabs[0]).toEqual(state.tabs[0]);
    expect(next.activeId).toBe(state.activeId);
  });

  it('leaves the state alone for a tab that is not open', () => {
    const state = withThree();

    expect(replaceHandle(state, 99, 'handle-x', 1)).toEqual(state);
  });
});

describe('applyDocState (W4.8 S1)', () => {
  const doc = (overrides: Partial<TabDocState> = {}): TabDocState => ({
    dirty: false,
    can_undo: false,
    can_redo: false,
    busy: '',
    ...overrides,
  });

  it('sets the dirty flag, undo state and busy flag of the tab with the handle, and no other', () => {
    const state = withThree();

    const next = applyDocState(
      state,
      'handle-b.pdf',
      doc({ dirty: true, can_undo: true, busy: 'save' }),
    );

    expect(next.tabs[1]).toMatchObject({ dirty: true, canUndo: true, canRedo: false, busy: true });
    expect(next.tabs[0]).toEqual(state.tabs[0]);
    expect(next.tabs[2]).toEqual(state.tabs[2]);
  });

  it('clears the dirty flag when the engine reports the document clean', () => {
    const dirty = setDirty(withThree(), 2, true);

    const next = applyDocState(dirty, 'handle-b.pdf', doc());

    expect(next.tabs.find((tab) => tab.id === 2)?.dirty).toBe(false);
  });

  it('ignores a state for a handle no tab holds', () => {
    const state = withThree();

    expect(applyDocState(state, 'handle-unknown', doc({ dirty: true }))).toBe(state);
  });

  it('returns the same state when nothing changed', () => {
    const state = withThree();

    expect(applyDocState(state, 'handle-a.pdf', doc())).toBe(state);
  });

  it('gives a new tab the signed flag of its open result, and starts it clean and idle', () => {
    const state = addTab(EMPTY_TABS, { ...pdf('signed.pdf'), signed: true });

    expect(state.tabs[0]).toMatchObject({
      signed: true,
      canUndo: false,
      canRedo: false,
      busy: false,
    });
    expect(addTab(EMPTY_TABS, pdf('plain.pdf')).tabs[0]?.signed).toBe(false);
  });
});

describe('renameTab (W4.9)', () => {
  it('gives the named tab its new name and leaves the others, their dirty flags and the handles', () => {
    let state = addTab(EMPTY_TABS, pdf('a.pdf'));
    state = addTab(state, pdf('b.pdf'));
    state = setDirty(state, 1, true);
    const renamed = renameTab(state, 1, 'copy.pdf');
    expect(renamed.tabs.map((tab) => [tab.name, tab.dirty, tab.handle])).toEqual([
      ['copy.pdf', true, 'handle-a.pdf'],
      ['b.pdf', false, 'handle-b.pdf'],
    ]);
  });

  it('leaves the state alone for an unknown tab id', () => {
    const state = addTab(EMPTY_TABS, pdf('a.pdf'));
    expect(renameTab(state, 99, 'x.pdf')).toEqual(state);
  });
});
