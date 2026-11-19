// The engine restart (W1.1 section 1, W3.9). The "Restart engine" button of the not-responding
// dialog calls this and nothing else restarts the engine. The engine connection owns the worker:
// replaceEngine starts the new one, then stops the old one, and the caller reopens each document
// it names from its last autosave (storage/autosaver.ts) through its own RPC client. This helper
// does not touch storage.
// A document that was open when the engine stopped. The id is the caller's own (for example the
// tab's document id); the helper only passes it on.
export interface OpenDocumentRef {
  readonly id: string;
  readonly name: string;
}

// What a restart loses, in the words the dialog shows (W1.1 section 1). The items are the same
// facts as text, so a UI can list them or show the sentence.
export interface LostWork {
  readonly items: readonly string[];
  readonly text: string;
}

export const LOST_WORK: LostWork = {
  items: ['the changes made since the last autosave', 'the undo history'],
  text: 'Changes made since the last autosave and the undo history are lost.',
};

export interface RestartOptions {
  // Replaces the engine (engineConnection.restart): the new worker starts before the old one stops.
  // False when the browser refuses the new worker; the old engine then keeps running.
  readonly replaceEngine: () => boolean;
  // Every document open in the engine, in the order the caller wants them reopened.
  readonly documents: readonly OpenDocumentRef[];
}

export type RestartResult =
  | {
      readonly ok: true;
      // The documents to reopen. The new engine's documents are not open yet: the caller reopens
      // each one once the engine is ready.
      readonly reopen: readonly OpenDocumentRef[];
      readonly lost: LostWork;
    }
  | {
      readonly ok: false;
      readonly code: 'ENGINE_START_FAILED';
    };

// A failed start changes nothing: the old engine still runs, and the dialog can offer Wait again.
export function restartEngine(options: RestartOptions): RestartResult {
  if (!options.replaceEngine()) return { ok: false, code: 'ENGINE_START_FAILED' };
  return { ok: true, reopen: [...options.documents], lost: LOST_WORK };
}
