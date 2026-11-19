// The document tabs as plain data (W1.6 section 3, W4.2b). A tab holds the engine handle of its
// open document and the page count the engine reported. The File itself is not kept: its bytes
// went to the engine when the document opened, and nothing here is written to storage.

export interface DocumentTab {
  readonly id: number;
  readonly name: string;
  readonly dirty: boolean;
  // The opaque handle session.open returned (W1.2 section 12). Every later call names it.
  readonly handle: string;
  readonly pages: number;
}

// A document the engine has opened, as the tab needs it.
export interface OpenedTab {
  readonly name: string;
  readonly handle: string;
  readonly pages: number;
}

export interface TabState {
  readonly tabs: readonly DocumentTab[];
  readonly activeId: number | null;
  readonly nextId: number;
}

export const EMPTY_TABS: TabState = { tabs: [], activeId: null, nextId: 1 };

// Adds a tab at the end and makes it the active one.
export function addTab(state: TabState, opened: OpenedTab): TabState {
  const tab: DocumentTab = {
    id: state.nextId,
    name: opened.name,
    dirty: false,
    handle: opened.handle,
    pages: opened.pages,
  };
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

// Stores the page count the engine reported after a change that added or removed pages.
export function setPageCount(state: TabState, id: number, pages: number): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, pages } : tab)),
  };
}

export function hasDirtyTab(state: TabState): boolean {
  return state.tabs.some((tab) => tab.dirty);
}
