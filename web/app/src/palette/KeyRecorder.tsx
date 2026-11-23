import { type KeyboardEvent, useState } from 'react';
import { type RecordedChord, chordFromKeyEvent } from '../commands/chord';
import { t } from '../i18n/t';

export interface KeyRecorderProps {
  // The command's name, for the button's accessible name.
  commandName: string;
  isMac: boolean;
  // The id of the element that explains the last key the user pressed.
  describedBy?: string;
  onCapture: (chord: RecordedChord) => void;
}

// Records the next key the user presses for a command (design section 7). It is a native button, so
// Tab and Shift+Tab are never captured and the recorder is not a keyboard trap (WCAG 2.1.2). Escape
// alone cancels recording and is stopped here, so the dialog does not close with it.
export function KeyRecorder({ commandName, isMac, describedBy, onCapture }: KeyRecorderProps) {
  const [recording, setRecording] = useState(false);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (event.key === 'Tab') {
      setRecording(false);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (
      event.key === 'Escape' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      setRecording(false);
      return;
    }
    const chord = chordFromKeyEvent(event, isMac);
    if (chord === undefined) return;
    setRecording(false);
    onCapture(chord);
  };

  return (
    <button
      type="button"
      className="shortcut-recorder"
      data-recording={recording ? 'true' : 'false'}
      aria-label={recording ? undefined : t('shortcuts.record.label', { name: commandName })}
      aria-describedby={describedBy}
      onClick={() => setRecording(true)}
      onKeyDown={onKeyDown}
      onBlur={() => setRecording(false)}
    >
      {recording ? t('shortcuts.record.recording') : t('shortcuts.record.start')}
    </button>
  );
}
