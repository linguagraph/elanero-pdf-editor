// The engine restart (W1.1 section 1, W3.9). The "Restart engine" button of the not-responding
// dialog calls this and nothing else restarts the engine. It starts a new engine worker and stops
// the old one, then names the documents the caller must reopen from their last autosave. It does
// not touch storage: the caller reads the autosave bytes (OPFS, once that task is built) and
// reopens each document through its own RPC client.
import { startEngine, type StartOptions, type WorkerClient } from './start';

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
  // The engine worker that stopped answering. It is terminated only after the new one started.
  readonly current: WorkerClient;
  readonly start: StartOptions;
  // Every document open in the engine, in the order the caller wants them reopened.
  readonly documents: readonly OpenDocumentRef[];
}

export type RestartResult =
  | {
      readonly ok: true;
      // The new engine. Its documents are not open yet: the caller reopens each one in `reopen`.
      readonly worker: WorkerClient;
      readonly reopen: readonly OpenDocumentRef[];
      readonly lost: LostWork;
    }
  | {
      readonly ok: false;
      readonly code: 'ENGINE_START_FAILED';
      readonly message: string;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The new worker is started before the old one is terminated. A start that fails therefore
// changes nothing: the old worker is still running, and the dialog can offer Wait again. The
// reverse order would leave the app with no engine and no way back to a working one.
export function restartEngine(options: RestartOptions): RestartResult {
  let worker: WorkerClient;
  try {
    worker = startEngine(options.start);
  } catch (error) {
    return { ok: false, code: 'ENGINE_START_FAILED', message: messageOf(error) };
  }
  options.current.terminate();
  return {
    ok: true,
    worker,
    reopen: [...options.documents],
    lost: LOST_WORK,
  };
}
