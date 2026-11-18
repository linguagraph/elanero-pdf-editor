// The translated words for what a restart loses (W1.1 section 1). The restart helper lists the
// facts as English items; this maps each one to its catalogue text, so the dialog and the restart
// toast show the same words. An item without a text is shown as the helper wrote it, and a test
// fails if the helper gains an item that has no text here.
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { LOST_WORK } from '../engine/restart';

const LOST_TEXT: Readonly<Record<string, MessageId>> = {
  'the changes made since the last autosave': 'engine.lost.autosave',
  'the undo history': 'engine.lost.undo',
};

export function lostItemText(item: string): string {
  const id: MessageId | undefined = LOST_TEXT[item];
  return id === undefined ? item : t(id);
}

// The lost items as one line, for a toast: "A; B".
export function lostItemsText(): string {
  return LOST_WORK.items.map(lostItemText).join('; ');
}
