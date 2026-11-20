// The highlight of a text selection on one page (W5.4 S3): the model's rectangles, one per line,
// drawn in CSS pixels for the zoom. The selection model (textSelection.ts) decides what is selected;
// these marks only show it, so the visible selection is the model's.
import { CSS_PX_PER_POINT } from '../view/zoom';
import type { PageTextIndex } from './pageTextIndex';
import type { TextSelection } from './textSelection';

// One highlight box, in CSS pixels from the page element's top-left corner.
export interface SelectionMarkBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

// The boxes the selection covers on one page. Empty until the page's index has arrived, since the
// model's rectangles come from it.
export function selectionMarkBoxes(
  selection: TextSelection,
  index: PageTextIndex | undefined,
  page: number,
  zoom: number,
): SelectionMarkBox[] {
  if (index === undefined) return [];
  const k = zoom * CSS_PX_PER_POINT;
  return selection.pageRects({ get: () => index }, page).map((rect) => ({
    left: rect.x0 * k,
    top: rect.y0 * k,
    width: (rect.x1 - rect.x0) * k,
    height: (rect.y1 - rect.y0) * k,
  }));
}

export interface SelectionMarksProps {
  readonly selection: TextSelection;
  readonly index: PageTextIndex | undefined;
  readonly page: number;
  readonly zoom: number;
}

export function SelectionMarks({ selection, index, page, zoom }: SelectionMarksProps) {
  return (
    <>
      {selectionMarkBoxes(selection, index, page, zoom).map((box, number) => (
        <div
          // The boxes of one page never reorder: the key is the line's position in the selection.
          key={number}
          className="page-selection-mark"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ))}
    </>
  );
}
