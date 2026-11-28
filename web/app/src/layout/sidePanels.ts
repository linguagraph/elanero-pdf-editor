// The open side panel of each side, for the whole app (W4.2a). One panel per side, as the desktop's
// SidePanels: opening a panel closes the other on its side. The state is not per tab: the panel
// stays open when the user switches documents. It is kept in memory, and the first document opens
// with Pages (the desktop's default_open="pages").
import { useSyncExternalStore } from 'react';

export type Side = 'left' | 'right';
export type PanelKey =
  | 'pages'
  | 'bookmarks'
  | 'attachments'
  | 'layers'
  | 'search'
  | 'redactions'
  | 'comments'
  | 'organizer';

// Which side each panel docks on. Every panel is on the left, in the left stack; the organizer
// joined it last (issue 827), after Comments.
export const PANEL_SIDE: Readonly<Record<PanelKey, Side>> = {
  pages: 'left',
  bookmarks: 'left',
  attachments: 'left',
  layers: 'left',
  search: 'left',
  redactions: 'left',
  comments: 'left',
  organizer: 'left',
};

type OpenState = Readonly<Record<Side, PanelKey | null>>;

const listeners = new Set<() => void>();
let state: OpenState = { left: 'pages', right: null };

function update(next: OpenState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

// Calls the listener after each change of either side. Returns the function that stops it.
export function subscribePanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openPanelOf(side: Side): PanelKey | null {
  return state[side];
}

export function openPanel(key: PanelKey): void {
  const side = PANEL_SIDE[key];
  if (state[side] === key) return;
  update({ ...state, [side]: key });
}

export function closePanel(side: Side): void {
  if (state[side] === null) return;
  update({ ...state, [side]: null });
}

export function togglePanel(key: PanelKey): void {
  const side = PANEL_SIDE[key];
  if (state[side] === key) closePanel(side);
  else openPanel(key);
}

// The panel open on a side, or null. Re-renders when that side changes.
export function useOpenPanel(side: Side): PanelKey | null {
  return useSyncExternalStore(
    subscribePanels,
    () => state[side],
    () => state[side],
  );
}
