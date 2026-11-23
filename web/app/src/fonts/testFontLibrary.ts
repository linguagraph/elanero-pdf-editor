// A FontLibrary for component tests (W6.9 slice 4): a list the test sets, and add, remove and
// removeAll as spies that answer with what the test says. Not used by the app.
import { type Mock, vi } from 'vitest';
import type { UploadedFontDto } from '../rpc/generated';
import type {
  AddOutcome,
  FontLibrary,
  FontLibraryState,
  LibraryFont,
  RemoveOutcome,
} from './fontLibrary';

export function libraryFont(
  overrides: Partial<LibraryFont> & { id: string; name: string },
): LibraryFont {
  return { size: 2048, kept: true, loaded: true, dto: undefined, ...overrides };
}

export function fontDto(overrides: Partial<UploadedFontDto> = {}): UploadedFontDto {
  return {
    id: 'a'.repeat(64),
    name: 'TestSans-Regular.ttf',
    format: 'truetype',
    size: 2048,
    path: `/fonts/${'a'.repeat(64)}.ttf`,
    faces: [
      {
        index: 0,
        family: 'Test Sans',
        style: 'Regular',
        weight: 400,
        italic: false,
        scripts: ['latin'],
        variable: false,
      },
    ],
    refused: [],
    ...overrides,
  };
}

export interface FakeFontLibrary extends FontLibrary {
  // Replaces the state the component reads and tells it to re-render.
  set(next: Partial<FontLibraryState>): void;
  add: Mock<(file: File) => Promise<AddOutcome>>;
  remove: Mock<(id: string) => Promise<RemoveOutcome>>;
  removeAll: Mock<() => Promise<RemoveOutcome>>;
}

export function fakeFontLibrary(start: Partial<FontLibraryState> = {}): FakeFontLibrary {
  let state: FontLibraryState = {
    fonts: [],
    usedBytes: 0,
    maxBytes: 256 * 1024 * 1024,
    storage: 'persistent',
    syncing: false,
    busy: false,
    ...start,
  };
  const listeners = new Set<() => void>();
  const library: FakeFontLibrary = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready: async () => undefined,
    add: vi.fn<(file: File) => Promise<AddOutcome>>(async () => ({
      kind: 'refused',
      code: 'OUT_OF_MEMORY',
      details: {},
    })),
    remove: vi.fn<(id: string) => Promise<RemoveOutcome>>(async () => ({ kind: 'removed' })),
    removeAll: vi.fn<() => Promise<RemoveOutcome>>(async () => ({ kind: 'removed' })),
    bytes: async () => undefined,
    cleared: () => undefined,
    onRemoved: () => () => undefined,
    set(next) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
  };
  return library;
}
