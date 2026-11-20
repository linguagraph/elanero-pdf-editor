// The Mark Pages handler (W4.13 S3): sends the chosen pages' areas through the controller, which
// makes one undo step, and says how many pages were marked. Ignored while an apply runs, as Mark
// Text is. Nothing is applied; the Redactions panel does not open.
import { toasts, type ToastStore } from '../feedback/toasts';
import { tp } from '../i18n/t';
import type { PageSize } from '../rpc/generated';
import type { PageArea } from '../text/textLayer';
import type { RedactionSnapshot } from './controller';
import { pageAreas } from './markPagesChoice';

export interface MarkPagesDeps {
  readonly controller: {
    getSnapshot(): Pick<RedactionSnapshot, 'busy'>;
    markAreas(areas: readonly PageArea[]): Promise<number>;
  };
  readonly store?: Pick<ToastStore, 'push'>;
}

// Marks each page whole. Resolves to true when at least one mark was added (the dialog closes).
export async function markWholePages(
  deps: MarkPagesDeps,
  pages: readonly number[],
  sizes: readonly PageSize[],
): Promise<boolean> {
  if (deps.controller.getSnapshot().busy) return false;
  const areas = pageAreas(pages, sizes);
  if (areas.length === 0) return false;
  const added = await deps.controller.markAreas(areas);
  if (added === 0) return false;
  (deps.store ?? toasts).push('success', tp('redact.markedPages', added));
  return true;
}
