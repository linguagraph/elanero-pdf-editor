// A byte count for people, shared by the dialog's headline and the space table so that the two
// never disagree. The number is formatted for the locale (formatDecimal), so "1.5 MB" is "1,5 MB"
// in German.
import { formatDecimal } from '../i18n/format';
import { t } from '../i18n/t';

// Bytes below 1 KB, then KB, MB and GB to one decimal place.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('compress.size.bytes', { count: bytes });
  const kb = bytes / 1024;
  if (kb < 1024) return t('compress.size.kb', { value: formatDecimal(kb, 1) });
  const mb = kb / 1024;
  if (mb < 1024) return t('compress.size.mb', { value: formatDecimal(mb, 1) });
  return t('compress.size.gb', { value: formatDecimal(mb / 1024, 1) });
}
