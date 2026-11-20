// The Save flow of a document tab (W4.8). The engine writes the whole document as verified bytes
// (save.save_bytes); the browser hands them over as a download under the document's own name; the
// engine then clears the dirty flag for the state it wrote (save.mark_saved). The browser cannot
// write over the original file, so the download is the copy that replaces it (W4.8b is the in-place
// write). A saver runs one save at a time per document and never calls an undo or edit.
import type { EngineClient } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import type { ErrorContext } from '../rpc/errors';
import { asRpcError } from '../documents/openFile';
import type { SaveMode, SaveResult } from '../rpc/generated';

// What the saver needs to know about the document to save.
export interface SaveTarget {
  readonly handle: string;
  // The download name, already a .pdf name (see pdfFileName).
  readonly name: string;
  // True when the document has signatures: an in-place save is then an incremental update.
  readonly signed: boolean;
  // True when the document was reopened from its autosave copy after an engine restart. Its
  // signature lineage is gone, so an in-place save of it would silently break the signatures.
  readonly restored: boolean;
}

export type SaveOutcome =
  | {
      readonly status: 'saved';
      readonly name: string;
      readonly incremental: boolean;
      readonly data: ArrayBuffer;
      // True when the engine refused to clear the dirty flag because the document changed while
      // the file was written: the download is still the state that was written, but the tab stays
      // dirty.
      readonly changedSince: boolean;
    }
  // The engine refused or failed. Nothing was downloaded and the tab stays dirty.
  | { readonly status: 'failed'; readonly error: RpcError; readonly context: ErrorContext }
  // The browser refused the download (for example a blocked pop-up). The bytes are kept so the
  // user can download them again; the tab stays dirty because the file was not handed over.
  | {
      readonly status: 'download-blocked';
      readonly name: string;
      readonly data: ArrayBuffer;
    }
  | { readonly status: 'skipped'; readonly reason: 'in-flight' | 'signed-restored' };

export interface Saver {
  save(target: SaveTarget, mode: SaveMode): Promise<SaveOutcome>;
}

export interface SaverDeps {
  readonly client: () => EngineClient | undefined;
  // Hands the bytes to the browser. It throws when the browser refuses the download.
  readonly download: (name: string, data: ArrayBuffer) => void;
}

export function createSaver(deps: SaverDeps): Saver {
  const running = new Set<string>();

  async function save(target: SaveTarget, mode: SaveMode): Promise<SaveOutcome> {
    if (running.has(target.handle)) return { status: 'skipped', reason: 'in-flight' };
    // A restored signed document refuses an in-place save (see SaveTarget.restored).
    if (mode === 'in_place' && target.signed && target.restored) {
      return { status: 'skipped', reason: 'signed-restored' };
    }
    const client = deps.client();
    if (client === undefined) {
      return {
        status: 'failed',
        error: new RpcError('ENGINE_ERROR', 'the engine is not ready'),
        context: {},
      };
    }
    running.add(target.handle);
    try {
      const context: ErrorContext = { signedInPlaceSave: target.signed && mode === 'in_place' };
      let saved: SaveResult;
      try {
        saved = await client.call('save.save_bytes', { handle: target.handle, mode });
      } catch (error) {
        return { status: 'failed', error: asRpcError(error), context };
      }
      try {
        deps.download(target.name, saved.data);
      } catch {
        return { status: 'download-blocked', name: target.name, data: saved.data };
      }
      // The file is with the user now, so the document is marked clean. A refusal here means the
      // document changed while it was written; any other failure leaves the tab dirty, which is
      // the safe side (the next save writes the newer state).
      let changedSince = false;
      try {
        await client.call('save.mark_saved', { handle: target.handle });
      } catch (error) {
        changedSince = asRpcError(error).code === 'STALE_OBJECT';
      }
      return {
        status: 'saved',
        name: target.name,
        incremental: saved.incremental,
        data: saved.data,
        changedSince,
      };
    } finally {
      running.delete(target.handle);
    }
  }

  return { save };
}
