import { useId, useState } from 'react';
import { Overlay } from '../layout/Overlay';
import { t } from '../i18n/t';
import type { DocumentTab } from '../tabs/tabState';
import { pdfFileName } from './fileName';

// What the dialog needs of the tab it saves as a new file.
export type SaveAsSource = Pick<DocumentTab, 'name' | 'signed' | 'encrypted'>;

export interface SaveAsDialogProps {
  // The tab being saved as a new file, or null while the dialog is closed.
  tab: SaveAsSource | null;
  // Gets the cleaned download name (always ending in .pdf).
  onSave(name: string): void;
  onCancel(): void;
}

// The Save As dialog (W4.9): it asks for a file name, prefilled with the tab's name, and hands back
// the name to save a full copy under. It sits on the Overlay host, so focus is trapped and Escape
// cancels. Its form state lives in the form, which unmounts when the dialog closes.
export function SaveAsDialog({ tab, onSave, onCancel }: SaveAsDialogProps) {
  return (
    <Overlay
      isOpen={tab !== null}
      onClose={onCancel}
      title={t('saveAs.title')}
      showCloseButton={false}
    >
      {tab === null ? null : (
        <SaveAsForm
          source={tab}
          onSubmit={(name) => {
            onSave(name);
          }}
          onCancel={onCancel}
        />
      )}
    </Overlay>
  );
}

// The part of a file name before its .pdf suffix, which is what the user usually edits.
export function nameStemLength(name: string): number {
  return /\.pdf$/i.test(name) ? name.length - '.pdf'.length : name.length;
}

interface SaveAsFormProps {
  source: SaveAsSource;
  onSubmit(name: string): void;
  onCancel(): void;
}

function SaveAsForm({ source, onSubmit, onCancel }: SaveAsFormProps) {
  const [value, setValue] = useState(source.name);
  const id = useId();
  const notes = [
    source.signed ? t('saveAs.signedNote') : null,
    source.encrypted ? t('saveAs.encryptedNote') : null,
  ].filter((note): note is string => note !== null);
  return (
    <form
      className="saveas-form"
      onSubmit={(event) => {
        event.preventDefault();
        // A blank name saves under the tab's own name, as the desktop's Save As keeps it.
        const raw = value.trim() === '' ? source.name : value;
        onSubmit(pdfFileName(raw, t('save.untitled')));
      }}
    >
      <label htmlFor={`${id}-input`}>{t('saveAs.label')}</label>
      <input
        id={`${id}-input`}
        type="text"
        autoComplete="off"
        autoFocus
        aria-describedby={notes.length > 0 ? `${id}-notes` : undefined}
        value={value}
        onFocus={(event) => {
          // Select the stem only, so typing replaces the name and keeps the .pdf suffix.
          event.currentTarget.setSelectionRange(0, nameStemLength(value));
        }}
        onChange={(event) => {
          setValue(event.currentTarget.value);
        }}
      />
      {notes.length > 0 ? (
        <div id={`${id}-notes`} className="saveas-notes">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onCancel}>
          {t('action.cancel')}
        </button>
        <button type="submit" className="feedback-primary">
          {t('saveAs.submit')}
        </button>
      </div>
    </form>
  );
}
