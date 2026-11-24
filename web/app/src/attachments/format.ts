// The text helpers of the attachments panel (W5.2, W7.9): how a size reads, the name a saved file
// gets, and the name a list entry shows. Kept apart from the component so the action layer can use
// them without importing the panel.
import { t } from '../i18n/t';
import type { AttachmentEntry } from '../rpc/generated';

// A byte count for people: bytes below 1 KB, then KB, MB and GB to one decimal place.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('attachments.size.bytes', { count: bytes });
  const kb = bytes / 1024;
  if (kb < 1024) return t('attachments.size.kb', { value: kb.toFixed(1) });
  const mb = kb / 1024;
  if (mb < 1024) return t('attachments.size.mb', { value: mb.toFixed(1) });
  return t('attachments.size.gb', { value: (mb / 1024).toFixed(1) });
}

// The name the file is saved under: the last part of the declared name, without path separators
// or control characters, since the declared name is untrusted text.
export function saveName(declared: string): string {
  // The control characters are stripped on purpose, so the pattern names them.
  // eslint-disable-next-line no-control-regex
  const base = (declared.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '' || base === '.' || base === '..' ? 'attachment' : base;
}

// The name a list entry shows: the declared file name, or the placeholder for an unnamed one.
export function displayName(entry: AttachmentEntry): string {
  return entry.filename === '' ? t('attachments.unnamed') : entry.filename;
}
