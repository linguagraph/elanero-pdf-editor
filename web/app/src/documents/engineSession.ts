// The restart's view of the open documents (W3.9 S3). The not-responding store asks it for each
// document's autosave copy and reopens the copy in the new engine; this builds that view from the
// tabs and the browser's autosave store, so the store never reads tabs or storage itself.
import type { EngineClient, EngineConnection } from '../engine/engineConnection';
import type { EngineSession } from '../feedback/notResponding';
import type { OpenResult } from '../rpc/generated';
import type { AutosaveStore } from '../storage/autosaveStore';
import type { DocumentTab } from '../tabs/tabState';

export interface RestartSessionInput {
  readonly engine: EngineConnection;
  readonly tabs: readonly DocumentTab[];
  // This browser tab's id: the folder the autosave copies are read from.
  readonly tabId: string;
  readonly store: AutosaveStore;
  readonly isProtected: (tabId: number) => boolean;
  // True while the tab is still open. It reads the live tab state, not the tabs above, which are
  // a snapshot: a tab closed during the restart's reopen loop is seen as closed (W3.9 S3).
  readonly isOpen: (tabId: number) => boolean;
  // Called once the copy is open in the new engine, with the tab and the engine's answer.
  readonly reopened: (tabId: number, client: EngineClient, opened: OpenResult) => void;
  // Called for a document that cannot come back: its tab closes, so no handle of the old engine
  // is kept (W3.9 S3).
  readonly lost: (tabId: number) => void;
}

export function restartSession(input: RestartSessionInput): EngineSession {
  return {
    engine: input.engine,
    // A document's id is its tab's id, which a restart keeps (the handle changes).
    documents: input.tabs.map((tab) => ({ id: String(tab.id), name: tab.name })),
    async bytesOf(documentId) {
      const copy = await input.store.read(input.tabId, Number(documentId));
      return copy?.bytes;
    },
    isProtected: (documentId) => input.isProtected(Number(documentId)),
    isOpen: (document) => input.isOpen(Number(document.id)),
    lost(document) {
      // A tab closed meanwhile has nothing to lose: it is left alone.
      if (input.isOpen(Number(document.id))) input.lost(Number(document.id));
    },
    async reopen(document, bytes, client) {
      const id = Number(document.id);
      const opened = await client.call('session.open', {
        name: document.name,
        data: bytes,
        password: null,
      });
      if (!input.isOpen(id)) {
        // The tab was closed while the copy opened: nothing may keep the new handle, so it is
        // closed in the new engine. A failure here leaves only an unused handle in a fresh engine.
        await client.call('session.close', { handle: opened.handle }).catch(() => undefined);
        return;
      }
      input.reopened(id, client, opened);
    },
  };
}
