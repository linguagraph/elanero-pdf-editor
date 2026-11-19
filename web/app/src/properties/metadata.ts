// The pure parts of the document properties dialog (W7.6): which fields are editable, which of
// them changed, the length limit, and the arguments of document.set_metadata. Nothing here calls
// the engine or draws anything.
import type { DocInfo } from '../rpc/generated';

// The fields the dialog edits. Creation and modification dates, the application and the producer
// are shown read-only, as the desktop dialog shows them.
export const EDITABLE_FIELDS = ['title', 'author', 'subject', 'keywords'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type EditableValues = Readonly<Record<EditableField, string>>;

// The action accepts any length; this is the web's limit for one field, so a very long value
// cannot make a file that other readers choke on. Counted in UTF-16 units, as JavaScript does.
export const MAX_FIELD_LENGTH = 1000;

// The editable values of the open document.
export function editableValues(info: DocInfo): EditableValues {
  return {
    title: info.title,
    author: info.author,
    subject: info.subject,
    keywords: info.keywords,
  };
}

// Only the fields whose value differs from the original, with their new value.
export function changedFields(
  original: EditableValues,
  edited: EditableValues,
): Partial<EditableValues> {
  const changed: Partial<Record<EditableField, string>> = {};
  for (const field of EDITABLE_FIELDS) {
    if (edited[field] !== original[field]) changed[field] = edited[field];
  }
  return changed;
}

// The edited fields longer than the limit, in the dialog's order. Empty when all fit.
export function overLongFields(values: EditableValues): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => values[field].length > MAX_FIELD_LENGTH);
}

// The arguments of document.set_metadata. The engine replaces the whole Info block, so the
// argument carries every Info field: the changed ones with their new value, the rest with the
// value the document already has. Sending only the changed fields would blank the others.
export function metadataArgs(
  info: DocInfo,
  changed: Partial<EditableValues>,
): Record<string, string> {
  return {
    title: changed.title ?? info.title,
    author: changed.author ?? info.author,
    subject: changed.subject ?? info.subject,
    keywords: changed.keywords ?? info.keywords,
    creator: info.creator,
    producer: info.producer,
    creation_date: info.creation_date,
    mod_date: info.mod_date,
  };
}
