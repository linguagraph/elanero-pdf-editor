// The space table in the compress result (W6.4, design section 4): the stored size of each part of
// the file before and after the run. A real table, so a screen reader reads each cell under its
// column header. The change is words ("less", "more", "No change"), not a sign or a colour.
import { useId } from 'react';
import type { SpaceCategoryKey } from '../rpc/generated';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import type { AuditRow } from './compressJob';
import { formatSize } from './formatSize';

// The labels of the parts, by the stable key (the desktop's names are not read). A new key in
// SPACE_CATEGORY_KEYS fails the typecheck here until it has a label. The space usage dialog reads
// the same labels.
export const CATEGORY_LABELS: Readonly<Record<SpaceCategoryKey, MessageId>> = {
  images: 'space.category.images',
  fonts: 'space.category.fonts',
  page_content: 'space.category.page_content',
  comments_forms: 'space.category.comments_forms',
  tags: 'space.category.tags',
  bookmarks_links: 'space.category.bookmarks_links',
  embedded_files: 'space.category.embedded_files',
  metadata_thumbnails: 'space.category.metadata_thumbnails',
  other: 'space.category.other',
  file_overhead: 'space.category.file_overhead',
};

// How a part changed, in words. A part that did not change says so rather than "0 B less".
function changeText(row: AuditRow): string {
  const delta = row.after - row.before;
  if (delta === 0) return t('compress.audit.same');
  return t(delta < 0 ? 'compress.audit.less' : 'compress.audit.more', {
    size: formatSize(Math.abs(delta)),
  });
}

export interface SpaceAuditTableProps {
  readonly rows: readonly AuditRow[];
  // The settings that ran, already translated: the caption names them.
  readonly settings: string;
}

export function SpaceAuditTable({ rows, settings }: SpaceAuditTableProps) {
  const ids = useId();
  const captionId = `${ids}-caption`;
  const noteId = `${ids}-note`;
  return (
    <>
      {/* The wrapper scrolls the table for large text; it takes keyboard focus so a keyboard
          user can scroll it (axe scrollable-region-focusable). */}
      <div className="compress-audit" role="group" aria-labelledby={captionId} tabIndex={0}>
        <table className="compress-audit-table" aria-describedby={noteId}>
          <caption id={captionId}>{t('compress.audit.caption', { settings })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('compress.audit.part')}</th>
              <th scope="col">{t('compress.audit.before')}</th>
              <th scope="col">{t('compress.audit.after')}</th>
              <th scope="col">{t('compress.audit.change')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{t(CATEGORY_LABELS[row.key])}</th>
                <td>{formatSize(row.before)}</td>
                <td>{formatSize(row.after)}</td>
                <td>{changeText(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p id={noteId} className="compress-hint">
        {t('compress.audit.note')}
      </p>
    </>
  );
}
