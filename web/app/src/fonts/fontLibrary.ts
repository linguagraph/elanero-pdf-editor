// The tab's uploaded fonts (W6.9 slice 3, design section 3). It owns the list, talks to the engine
// and the browser's private storage, and runs one job at a time so syncs and adds never interleave.
import { useSyncExternalStore } from 'react';
import type { EngineClient, EngineConnection } from '../engine/engineConnection';
import { RpcError, type RpcErrorCode } from '../rpc/client';
import type { FontAddResult, UploadedFontDto } from '../rpc/generated';
import {
  type FontStore,
  type KeepOutcome,
  requestPersistence,
  type StoredFontRecord,
} from '../storage/fontStore';
import type { BlobLike } from '../storage/opfs';
import { toasts } from '../feedback/toasts';
import { t } from '../i18n/t';

// Hand copy of limits.MAX_FONT_BYTES (50 MiB); the worker re-checks it (design S3 question 8).
export const MAX_FONT_FILE_BYTES = 50 * 1024 * 1024;
// Codes that cannot succeed on a retry: a kept font with one of them is removed at start-up.
const PERMANENT = new Set(['INVALID_FONT', 'FONT_NOT_EMBEDDABLE', 'FILE_TOO_LARGE']);

export type FontStorage = 'persistent' | 'session' | 'unknown';

// A font the tab lists. Kept fonts are on disk; loaded fonts are in the current engine. A kept font
// the engine has not loaded yet has no dto (its faces come from the engine).
export interface LibraryFont {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly kept: boolean;
  readonly loaded: boolean;
  readonly dto: UploadedFontDto | undefined;
}

export interface FontLibraryState {
  readonly fonts: readonly LibraryFont[];
  // From the engine's last reply.
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly storage: FontStorage;
  readonly syncing: boolean;
  readonly busy: boolean;
}

export type AddOutcome =
  | { readonly kind: 'added'; readonly font: LibraryFont }
  | { readonly kind: 'already'; readonly font: LibraryFont }
  | {
      readonly kind: 'notKept';
      readonly font: LibraryFont;
      readonly reason: Exclude<KeepOutcome, 'kept'>;
    }
  | { readonly kind: 'tooLarge' }
  | {
      readonly kind: 'refused';
      readonly code: RpcErrorCode;
      readonly details: Record<string, unknown>;
    };

export interface FontLibraryDeps {
  readonly engine: Pick<EngineConnection, 'client' | 'whenReady' | 'onReady'>;
  readonly store: FontStore;
  readonly persist?: () => Promise<unknown>;
  // Runs a start-up sync when the page is idle. Defaults to requestIdleCallback with a 2 s timeout.
  readonly schedule?: (run: () => void) => void;
  // Shows a warning toast. Defaults to the app's toast store.
  readonly notify?: (text: string) => void;
}

export interface FontLibrary {
  getState(): FontLibraryState;
  subscribe(listener: () => void): () => void;
  // Resolves when the current engine holds every kept font (the first sync of each engine).
  ready(): Promise<void>;
  add(file: File): Promise<AddOutcome>;
  // The bytes of a font the tab lists (kept or this tab only), for the preview face (W6.8b).
  bytes(id: string): Promise<BlobLike | undefined>;
}

// One font the tab knows. A session font (kept false) holds its File for re-sends after a restart.
interface Entry {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly added: string;
  kept: boolean;
  loaded: boolean;
  dto: UploadedFontDto | undefined;
  file: BlobLike | undefined;
}

type LoadResult =
  | { readonly kind: 'ok'; readonly reply: FontAddResult }
  | { readonly kind: 'permanent' }
  | { readonly kind: 'failed' };

function defaultSchedule(run: () => void): void {
  const host = globalThis as unknown as {
    requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
  };
  if (typeof host.requestIdleCallback === 'function') {
    // Called as a method: browsers reject an unbound call with "Illegal invocation".
    host.requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

function byAddedThenId(a: Entry, b: Entry): number {
  return a.added === b.added ? a.id.localeCompare(b.id) : a.added.localeCompare(b.added);
}

function view({ id, name, size, kept, loaded, dto }: Entry): LibraryFont {
  return { id, name, size, kept, loaded, dto };
}

// A promise its owner resolves later; `done` says whether it has been resolved.
interface Gate {
  readonly promise: Promise<void>;
  done: boolean;
  resolve(): void;
}

function openGate(): Gate {
  let resolveFn: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  const gate: Gate = {
    promise,
    done: false,
    resolve() {
      gate.done = true;
      resolveFn();
    },
  };
  return gate;
}

export function createFontLibrary(deps: FontLibraryDeps): FontLibrary {
  const { engine, store } = deps;
  const persist = deps.persist ?? requestPersistence;
  const schedule = deps.schedule ?? defaultSchedule;
  const notify = deps.notify ?? ((text: string) => toasts.push('warning', text));
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let usedBytes = 0;
  let maxBytes = 0;
  let storage: FontStorage = 'unknown';
  let persistAsked = false;
  let syncing = false;
  let pending = 0;
  // Each engine gets a number. A sync of an older engine sees a different one and does nothing.
  let generation = 0;
  let current: EngineClient | undefined;
  let gate = openGate();
  let tail: Promise<unknown> = Promise.resolve();
  let state: FontLibraryState = snapshot();

  function snapshot(): FontLibraryState {
    return {
      fonts: [...entries.values()].sort(byAddedThenId).map(view),
      usedBytes,
      maxBytes,
      storage,
      syncing,
      busy: pending > 0,
    };
  }

  function publish(): void {
    state = snapshot();
    for (const listener of listeners) listener();
  }

  // Runs one job after the one before it. busy is true while any job is queued or running.
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    pending += 1;
    publish();
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    void tail.then(() => {
      pending -= 1;
      publish();
    });
    return run;
  }

  function setUsage(reply: { used_bytes: number; max_bytes: number }): void {
    usedBytes = reply.used_bytes;
    maxBytes = reply.max_bytes;
  }

  function askPersist(): void {
    if (persistAsked) return;
    persistAsked = true;
    void persist().catch(() => undefined);
  }

  // Sends one font to the engine. A permanent refusal and any other failure are told apart.
  async function loadOne(client: EngineClient, name: string, blob: BlobLike): Promise<LoadResult> {
    try {
      const reply = await client.call('fonts.add', { name, data: await blob.arrayBuffer() });
      return { kind: 'ok', reply };
    } catch (error) {
      return error instanceof RpcError && PERMANENT.has(error.code)
        ? { kind: 'permanent' }
        : { kind: 'failed' };
    }
  }

  // Reads the engine's own list: it sets which fonts are loaded and their faces.
  async function refreshFromEngine(client: EngineClient, mine: number): Promise<void> {
    try {
      const list = await client.call('fonts.list', {});
      // An engine replaced during the call must not mark fonts loaded in the new one.
      if (mine !== generation) return;
      setUsage(list);
      const loaded = new Map(list.fonts.map((dto) => [dto.id, dto]));
      for (const entry of entries.values()) {
        const dto = loaded.get(entry.id);
        entry.loaded = dto !== undefined;
        if (dto !== undefined) entry.dto = dto;
      }
    } catch {
      // The list stays as it was; the next sync corrects it.
    }
  }

  // Brings the engine up to the tab's fonts: every kept font and every session font it lacks.
  async function reconcile(client: EngineClient, mine: number): Promise<void> {
    const records = await store.list();
    const onDisk = new Set(records.map((record) => record.id));
    for (const entry of [...entries.values()]) {
      if (entry.kept && !onDisk.has(entry.id)) entries.delete(entry.id);
    }
    for (const record of records) {
      const entry = entries.get(record.id);
      if (entry === undefined) entries.set(record.id, fromRecord(record));
      else entry.kept = true;
    }
    if (!(await store.available())) storage = 'session';
    if (entries.size === 0) return;
    let failed = false;
    let sent = false;
    for (const entry of [...entries.values()]) {
      // The engine was replaced: the new engine's own sync takes over, so this one stops here.
      if (mine !== generation) return;
      if (entry.loaded) continue;
      const blob = entry.kept ? await store.read(entry.id) : entry.file;
      if (mine !== generation) return;
      if (blob === undefined) continue;
      sent = true;
      const result = await loadOne(client, entry.name, blob);
      if (mine !== generation) return;
      if (result.kind === 'ok' && result.reply.font.id === entry.id) {
        entry.dto = result.reply.font;
        entry.loaded = true;
        setUsage(result.reply);
      } else if (result.kind === 'ok' || result.kind === 'permanent') {
        // A mismatched id means the bytes changed on disk; a permanent refusal cannot succeed.
        entries.delete(entry.id);
        if (entry.kept) {
          await store.remove(entry.id);
          notify(t('fonts.load.dropped', { name: entry.name }));
        }
        // The worker kept the changed bytes under their new id: drop them there too, unless that id
        // is another listed font (the residue rule).
        if (result.kind === 'ok' && !entries.has(result.reply.font.id)) {
          await client.call('fonts.remove', { id: result.reply.font.id }).catch(() => undefined);
        }
      } else {
        failed = true;
      }
    }
    if (sent) await refreshFromEngine(client, mine);
    if (failed && mine === generation) notify(t('fonts.load.failed'));
  }

  function fromRecord({ id, name, size, added }: StoredFontRecord): Entry {
    return { id, name, size, added, kept: true, loaded: false, dto: undefined, file: undefined };
  }

  async function sync(client: EngineClient, mine: number): Promise<void> {
    if (mine !== generation) return;
    syncing = true;
    publish();
    try {
      await reconcile(client, mine);
    } finally {
      syncing = false;
      // Only the current engine's first full sync opens the gate.
      if (mine === generation) gate.resolve();
      publish();
    }
  }

  // The engine is ready: every font is unloaded until a sync says otherwise; a sync runs at idle.
  engine.onReady((client) => {
    // Each successful hello makes a new client; the same one again is not a new engine.
    if (client === current) return;
    current = client;
    generation += 1;
    if (gate.done) gate = openGate();
    const mine = generation;
    for (const entry of entries.values()) entry.loaded = false;
    publish();
    schedule(() => {
      if (mine === generation) void enqueue(() => sync(client, mine));
    });
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready: () => gate.promise,

    add(file) {
      if (file.size > MAX_FONT_FILE_BYTES) return Promise.resolve({ kind: 'tooLarge' });
      return enqueue(async (): Promise<AddOutcome> => {
        const client = engine.client() ?? (await engine.whenReady());
        // The engine this add talks to. A restart while it is in flight makes the generation move on.
        const mine = generation;
        let reply: FontAddResult;
        try {
          reply = await client.call('fonts.add', {
            name: file.name,
            data: await file.arrayBuffer(),
          });
        } catch (error) {
          if (error instanceof RpcError)
            return { kind: 'refused', code: error.code, details: error.details };
          return { kind: 'refused', code: 'ENGINE_ERROR', details: {} };
        }
        const stale = mine !== generation;
        if (!stale) setUsage(reply);
        const { font } = reply;
        const existing = entries.get(font.id);
        if (existing?.kept === true) {
          // A stale reply leaves the font unloaded: the new engine's sync sends it.
          existing.dto = stale ? undefined : font;
          existing.loaded = !stale;
          publish();
          return { kind: 'already', font: view(existing) };
        }
        const record: StoredFontRecord = {
          id: font.id,
          name: font.name,
          size: font.size,
          fontFormat: font.format,
          added: new Date().toISOString(),
        };
        const entry: Entry = {
          ...fromRecord(record),
          kept: false,
          loaded: false,
          dto: undefined,
          file,
        };
        // The bytes are kept from the File itself: the send above detached the buffer.
        const outcome = await store.write(record, file);
        // Checked after the write too: a restart during it also leaves the font for the new engine.
        const current = mine === generation;
        entry.loaded = current;
        entry.dto = current ? font : undefined;
        if (outcome === 'kept') {
          entry.kept = true;
          entry.file = undefined;
          storage = 'persistent';
          askPersist();
        } else if (outcome === 'unsupported') {
          storage = 'session';
        }
        entries.set(font.id, entry);
        publish();
        return outcome === 'kept'
          ? { kind: 'added', font: view(entry) }
          : { kind: 'notKept', font: view(entry), reason: outcome };
      });
    },

    async bytes(id) {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      return entry.kept ? store.read(id) : entry.file;
    },
  };
}

// The library's state for a React component. The library is created once per page.
export function useFontLibrary(library: FontLibrary): FontLibraryState {
  return useSyncExternalStore(
    (listener) => library.subscribe(listener),
    () => library.getState(),
    () => library.getState(),
  );
}
