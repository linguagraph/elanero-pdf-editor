// The document tabs as plain data (W1.6 section 3, W4.2b). A tab holds the engine handle of its
// open document and the page count the engine reported. The File itself is not kept: its bytes
// went to the engine when the document opened, and nothing here is written to storage.
import type { DocStateDto } from '../rpc/generated';

export interface DocumentTab {
  readonly id: number;
  readonly name: string;
  readonly dirty: boolean;
  // The opaque handle session.open returned (W1.2 section 12). Every later call names it.
  readonly handle: string;
  readonly pages: number;
  // True when the document is encrypted (its open result says so). Such a document is never
  // reopened from an autosave copy (W3.9 S3, D2).
  readonly encrypted: boolean;
  // True when the document carries signatures (its open result says so). Its in-place saves are
  // incremental, so they are refused once the lineage is broken (W4.8).
  readonly signed: boolean;
  // True when the engine can change the document's content (its content_edit capability, W6.7a).
  // The Edit tool's commands are off without it.
  readonly contentEdit: boolean;
  // The engine's undo and redo state, from its state events (W4.8 S1).
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  // True while a background task makes the document read-only (the engine's busy field).
  readonly busy: boolean;
  // True when the document was reopened from its autosave copy after an engine restart (W3.9). Its
  // signature lineage is gone, so an in-place save of a signed one is refused (W4.8).
  readonly restored: boolean;
}

// A document the engine has opened, as the tab needs it.
export interface OpenedTab {
  readonly name: string;
  readonly handle: string;
  readonly pages: number;
  readonly encrypted?: boolean;
  readonly signed?: boolean;
  readonly contentEdit?: boolean;
}

// The fields of the engine's document state that the tab shows (its state events, W4.8 S1).
export type TabDocState = Pick<DocStateDto, 'dirty' | 'can_undo' | 'can_redo' | 'busy'>;

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
    encrypted: opened.encrypted === true,
    signed: opened.signed === true,
    contentEdit: opened.contentEdit === true,
    canUndo: false,
    canRedo: false,
    busy: false,
    restored: false,
  };
  return { tabs: [...state.tabs, tab], activeId: tab.id, nextId: state.nextId + 1 };
}

// The tab Next (step 1) or Previous (step -1) Document goes to, wrapping at the ends (W4.3b D6, as
// the desktop's _cycle_tab). With no tab active, Next takes the first and Previous the last. Null
// when there are no tabs.
export function neighbourTabId(state: TabState, step: 1 | -1): number | null {
  const { tabs, activeId } = state;
  if (tabs.length === 0) return null;
  const at = tabs.findIndex((tab) => tab.id === activeId);
  const base = at < 0 ? (step > 0 ? -1 : tabs.length) : at;
  return tabs[(base + step + tabs.length) % tabs.length]?.id ?? null;
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

// Applies the engine's state of one document to its tab (W4.8 S1). A handle no tab holds is
// ignored, and so is a state that changes nothing: the state is the source of the dirty dot, the
// unload warning and the autosave of the tab.
export function applyDocState(state: TabState, handle: string, doc: TabDocState): TabState {
  const found = state.tabs.find((tab) => tab.handle === handle);
  if (found === undefined) return state;
  const busy = doc.busy !== '';
  if (
    found.dirty === doc.dirty &&
    found.canUndo === doc.can_undo &&
    found.canRedo === doc.can_redo &&
    found.busy === busy
  ) {
    return state;
  }
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.handle === handle
        ? { ...tab, dirty: doc.dirty, canUndo: doc.can_undo, canRedo: doc.can_redo, busy }
        : tab,
    ),
  };
}

// Gives a tab the name of the file it was saved as (W4.9). The tab's name is the source of the
// download name of its next save, so it follows the Save As choice.
export function renameTab(state: TabState, id: number, name: string): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, name } : tab)),
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

// Points a tab at the handle of its document reopened after an engine restart (W3.9 S3). The copy
// that reopened it holds the unsaved changes, so the tab is dirty again: it keeps being autosaved
// and the page still warns before it closes.
export function replaceHandle(
  state: TabState,
  id: number,
  handle: string,
  pages: number,
): TabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, handle, pages, dirty: true, restored: true } : tab,
    ),
  };
}
