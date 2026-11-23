// The tab's font library for the editor (W6.8b 8b-3). main.tsx provides it once; the paragraph
// editor reads it for the picker's Uploaded section. With no provider (tests), there are no uploads.
import { createContext, useSyncExternalStore } from 'react';
import type { FontLibrary, LibraryFont } from './fontLibrary';

export const FontLibraryContext = createContext<FontLibrary | undefined>(undefined);

const NO_FONTS: readonly LibraryFont[] = [];

// The library's fonts, re-rendered on each change. `getState().fonts` is a new array only when the
// library publishes, so the snapshot is stable between changes.
export function useUploadedFonts(library: FontLibrary | undefined): readonly LibraryFont[] {
  return useSyncExternalStore(
    (listener) => (library === undefined ? () => undefined : library.subscribe(listener)),
    () => library?.getState().fonts ?? NO_FONTS,
  );
}
