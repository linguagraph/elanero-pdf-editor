// The bridge between the organizer panel and the ribbon (issue 736). The panel owns its selection
// and its operations, and only the panel mounts: this store publishes what the ribbon needs (the
// selection, the page total and whether a change runs) and the panel's own actions, so a ribbon
// command runs the same closure, and the same delete confirmation, as the panel's button. The
// shape follows layout/sidePanels.ts: a module-level store read with useSyncExternalStore.
import { useSyncExternalStore } from 'react';

// The ribbon's page commands that the panel serves.
export type OrganizerCommandId =
  | 'rotate-pages-left'
  | 'rotate-pages-right'
  | 'insert-pages'
  | 'duplicate-pages'
  | 'extract-pages'
  | 'delete-pages'
  | 'replace-pages';

export interface OrganizerStatus {
  readonly selected: number;
  readonly total: number;
  readonly busy: boolean;
}

// Each action is the panel's own closure. Each one checks the panel's rules itself (no selection,
// busy, one page), so a press from the ribbon cannot do what the disabled button would not.
export interface OrganizerActions {
  rotate(delta: number): void;
  insertFile(): void;
  duplicate(): void;
  extract(): void;
  askDelete(): void;
  replace(): void;
}

let status: OrganizerStatus | null = null;
// The actions are read on a press, not rendered, so a new object each panel render is not a change.
let actions: OrganizerActions | null = null;
// Commands run from the ribbon while no panel was ready. The panel takes them once its pages load.
let queued: OrganizerCommandId[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function sameStatus(a: OrganizerStatus | null, b: OrganizerStatus): boolean {
  return a !== null && a.selected === b.selected && a.total === b.total && a.busy === b.busy;
}

// Called by the panel after each render. Listeners hear about a change of the status only.
export function publishOrganizer(next: OrganizerStatus, nextActions: OrganizerActions): void {
  actions = nextActions;
  if (sameStatus(status, next)) return;
  status = next;
  notify();
}

// Stops publishing: the panel's status and actions are withdrawn, and the ribbon's page commands
// queue (and open the panel) until the panel publishes again. Queued commands stay queued.
export function withdrawOrganizer(): void {
  actions = null;
  if (status === null) return;
  status = null;
  notify();
}

// Called when the panel unmounts: the ribbon's page commands go back to opening the panel, and a
// command still queued for a panel that is gone is dropped. (The app does not run under StrictMode;
// there, the simulated unmount right after mount would drop a command queued before the mount.)
export function clearOrganizer(): void {
  queued = [];
  withdrawOrganizer();
}

export function subscribeOrganizer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOrganizerStatus(): OrganizerStatus | null {
  return status;
}

export function getOrganizerActions(): OrganizerActions | null {
  return actions;
}

// Whether any ribbon command waits for the panel.
export function hasQueuedOrganizerCommands(): boolean {
  return queued.length > 0;
}

// The panel's pending commands, in order. Taking them empties the queue, so each runs once.
export function takeQueuedOrganizerCommands(): OrganizerCommandId[] {
  const taken = queued;
  queued = [];
  return taken;
}

// Runs the panel's action for a ribbon command. Calls on a panel that is not ready queue the command
// and open the panel, which runs it once its pages have loaded.
export function runOrganizerCommand(id: OrganizerCommandId, open: () => void): void {
  if (actions === null) {
    queued = [...queued, id];
    open();
    return;
  }
  runOrganizerAction(id, actions);
}

// The panel action a ribbon command names. Shared with the panel, which runs the queued commands.
export function runOrganizerAction(id: OrganizerCommandId, panel: OrganizerActions): void {
  switch (id) {
    case 'rotate-pages-left':
      panel.rotate(270);
      return;
    case 'rotate-pages-right':
      panel.rotate(90);
      return;
    case 'insert-pages':
      panel.insertFile();
      return;
    case 'duplicate-pages':
      panel.duplicate();
      return;
    case 'extract-pages':
      panel.extract();
      return;
    case 'delete-pages':
      panel.askDelete();
      return;
    case 'replace-pages':
      panel.replace();
      return;
  }
}

// The panel's status, or null when no panel is publishing (the panel is closed or still loading).
export function useOrganizerStatus(): OrganizerStatus | null {
  return useSyncExternalStore(subscribeOrganizer, getOrganizerStatus, getOrganizerStatus);
}
