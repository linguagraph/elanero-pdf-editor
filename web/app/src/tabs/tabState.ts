// The document tabs as plain data (W1.6 section 3, W4.2b). A tab holds the File the user chose, in
// memory only: nothing here is written to storage, and the File is released when the tab closes.
// The engine does not open these files yet; that wiring comes with the RPC session.

export interface DocumentTab {
  readonly id: number;
  readonly name: string;
  readonly dirty: boolean;
  readonly file: File;
}

export interface TabState {
  readonly tabs: readonly DocumentTab[];
  readonly activeId: number | null;
  readonly nextId: number;
}

export const EMPTY_TABS: TabState = { tabs: [], activeId: null, nextId: 1 };

// Adds a tab at the end and makes it the active one.
export function addTab(state: TabState, file: File): TabState {
  const tab: DocumentTab = { id: state.nextId, name: file.name, dirty: false, file };
  return { tabs: [...state.tabs, tab], activeId: tab.id, nextId: state.nextId + 1 };
}

export function activateTab(state: TabState, id: number): TabState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state;
}

// Removes a tab. When the active tab goes, the tab after it takes over, or the one before it when
// it was the last; with no tabs left the active id is null.
export function closeTab(state: TabState, id: number): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { ...state, tabs };
  const neighbour = tabs[index] ?? tabs[index - 1];
  return { ...state, tabs, activeId: neighbour?.id ?? null };
}

export function setDirty(state: TabState, id: number, dirty: boolean): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)),
  };
}

export function hasDirtyTab(state: TabState): boolean {
  return state.tabs.some((tab) => tab.dirty);
}
