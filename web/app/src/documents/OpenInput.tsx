import type { RefObject } from 'react';

export interface OpenInputProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  onFiles(files: readonly File[]): void;
}

// The file picker behind Open (the start page's button, the ribbon, the app menu). It is hidden:
// the visible Open buttons are the accessible way in, and they call click() on this input. The
// value is cleared after each pick, so picking the same file again still fires a change.
export function OpenInput({ inputRef, onFiles }: OpenInputProps) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="application/pdf"
      multiple
      hidden
      tabIndex={-1}
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = '';
        onFiles(files);
      }}
    />
  );
}
