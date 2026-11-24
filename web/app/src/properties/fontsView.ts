// How the Fonts tab shows a font row (W7.6): the embedding label and the compact page ranges. The
// rules follow the desktop dialog (ui/dialogs/properties.py); the shared vectors in
// web/test/vectors/font-pages.json hold the desktop's answers for the range formatter.
import type { MessageId } from '../i18n/en';
import type { FontRow } from '../rpc/generated';

// The subset flag is checked first, as on the desktop: a subset name is "Embedded subset" even
// when the engine reports no font file for it.
export function embeddingLabel(row: Pick<FontRow, 'embedded' | 'subset'>): MessageId {
  if (row.subset) return 'properties.fonts.subset';
  return row.embedded ? 'properties.fonts.embedded' : 'properties.fonts.notEmbedded';
}

function segment(from: number, to: number): string {
  return from === to ? `${from + 1}` : `${from + 1}-${to + 1}`;
}

// 0-based pages in, 1-based compact text out: [0, 1, 2, 6] reads "1-3, 7". Duplicates are
// dropped; the engine never sends them.
export function pageRangeText(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const page of sorted) {
    if (start !== null && page === prev + 1) {
      prev = page;
      continue;
    }
    if (start !== null) out.push(segment(start, prev));
    start = page;
    prev = page;
  }
  if (start !== null) out.push(segment(start, prev));
  return out.join(', ');
}
