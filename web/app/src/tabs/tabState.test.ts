import { describe, expect, it } from 'vitest';
import {
  activateTab,
  addTab,
  closeTab,
  EMPTY_TABS,
  hasDirtyTab,
  setDirty,
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
});
