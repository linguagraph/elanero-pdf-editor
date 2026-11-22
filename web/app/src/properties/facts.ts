// Shared wording for the properties panels (W7.6): the label of each editable field and how a
// read-only value is shown. Values from the file are rendered as text, never passed to t().
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import type { EditableField } from './metadata';

export const FIELD_LABEL: Record<EditableField, MessageId> = {
  title: 'properties.field.title',
  author: 'properties.field.author',
  subject: 'properties.field.subject',
  keywords: 'properties.field.keywords',
};

// An empty value reads as "Not set" (the desktop wording), not as a blank cell.
export function shownValue(value: string): string {
  return value === '' ? t('properties.empty') : value;
}

export function yesNo(flag: boolean): string {
  return flag ? t('properties.yes') : t('properties.no');
}
