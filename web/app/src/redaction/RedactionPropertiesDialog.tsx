// Redaction Properties (W4.14): the style of the marks drawn from now on, edited over the same
// preference keys the Preferences dialog's redaction section uses. It is enabled with no document
// open and never changes the document: a mark takes the style when it is made, so a change here
// applies to the next mark only, and marks already drawn keep theirs.
import { useState } from 'react';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { OVERLAY_TEXT_MAX_LENGTH, readPreferences, writePreferences } from '../prefs/store';
import '../prefs/preferences.css';
import { MarkStyleFields } from './MarkStyleFields';
import {
  applyStylePatch,
  draftFromPreferences,
  type MarkStyleDraft,
  preferencesFromDraft,
} from './redactionProperties';

export interface RedactionPropertiesDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function RedactionPropertiesDialog({ isOpen, onClose }: RedactionPropertiesDialogProps) {
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onClose}
      title={t('redactions.properties')}
      showCloseButton={false}
    >
      <PropertiesForm onDone={onClose} />
    </Overlay>
  );
}

// Mounted only while the dialog is open (the overlay renders nothing when closed), so every open
// starts from the saved style. It is not a <form>: Enter in the overlay text field only commits the
// text, and Apply is an explicit click, so no implicit submit can drop an uncommitted edit.
function PropertiesForm({ onDone }: { readonly onDone: () => void }) {
  const [draft, setDraft] = useState<MarkStyleDraft>(() => draftFromPreferences(readPreferences()));

  const apply = () => {
    // The other preferences are read again, so only the three style keys change.
    writePreferences({ ...readPreferences(), ...preferencesFromDraft(draft) });
    onDone();
  };

  return (
    <div className="redaction-properties">
      <span className="prefs-hint">{t('prefs.redaction.hint')}</span>
      <MarkStyleFields
        value={draft}
        overlayMaxLength={OVERLAY_TEXT_MAX_LENGTH}
        onChange={(patch) => setDraft((previous) => applyStylePatch(previous, patch))}
      />
      <span className="prefs-hint">{t('prefs.redaction.overlayHint')}</span>
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onDone}>
          {t('prefs.cancel')}
        </button>
        <button type="button" className="overlay-close prefs-apply" onClick={apply}>
          {t('prefs.apply')}
        </button>
      </div>
    </div>
  );
}
