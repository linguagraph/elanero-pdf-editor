// The font file picker's logic (W6.9 slice 4, design section 4.3). Preferences ▸ Fonts uses it now,
// and the font picker's "Upload font…" row (W6.8b) will share it. The owner renders the hidden input
// with `ref={inputRef}`, `accept={FONT_ACCEPT}` and `onChange={upload.onChange}`, and opens it with
// `upload.open()` from a click handler.
import { type ChangeEvent, type RefObject, useCallback } from 'react';
import type { AddOutcome, FontLibrary } from './fontLibrary';

export const FONT_ACCEPT = '.ttf,.otf,.ttc,.otc,font/ttf,font/otf,font/collection';

export type UploadReport = (file: File, outcome: AddOutcome) => void;

export interface FontUpload {
  // Opens the file dialog through the hidden input. Called from an event handler only.
  open(): void;
  // Takes the picked files, then clears the input so the same file can be picked again.
  onChange(event: ChangeEvent<HTMLInputElement>): void;
  // Adds the files one after another, reporting each outcome as it arrives.
  upload(files: readonly File[]): Promise<void>;
}

export function useFontUpload(
  library: FontLibrary | undefined,
  report: UploadReport,
  inputRef: RefObject<HTMLInputElement | null>,
): FontUpload {
  const upload = useCallback(
    async (files: readonly File[]) => {
      if (library === undefined) return;
      for (const file of files) {
        let outcome: AddOutcome;
        try {
          outcome = await library.add(file);
        } catch {
          // The library answers refusals itself; a throw here means the engine link failed.
          outcome = { kind: 'refused', code: 'ENGINE_ERROR', details: {} };
        }
        report(file, outcome);
      }
    },
    [library, report],
  );

  return {
    open: () => inputRef.current?.click(),
    onChange(event) {
      // Copied before the input is cleared: clearing empties the live file list.
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = '';
      if (files.length > 0) void upload(files);
    },
    upload,
  };
}
