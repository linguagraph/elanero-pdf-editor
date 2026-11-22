// The start and end handles of a touch or pen selection (W5.4 S2, design section 3). Each is a
// transparent 44 x 44 CSS px box under the selection's end line, with a round knob at its top. The
// handles are a pointer affordance only: they are aria-hidden, and the keyboard path does not use them.
// Their place comes from the model and the zoom at each render, so a zoom or a scroll moves them.
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PageTextIndex } from './pageTextIndex';
import { selectionMarkBoxes } from './SelectionMarks';
import type { TextSelection } from './textSelection';

// The hit box's side in CSS px: the W8.5 touch-target rule, always, not only under `pointer: coarse`.
export const HANDLE_BOX_PX = 44;
// The edge zone, in CSS px, inside which a dragged handle scrolls the view, and the most it scrolls
// per frame (section 3, auto-scroll).
export const AUTO_SCROLL_EDGE_PX = 32;
export const AUTO_SCROLL_MAX_PX = 12;

export type HandleEnd = 'start' | 'end';

// One handle on one page, in CSS px from the page element's top-left corner. `top` is the bottom of
// the selection's line, where the box begins; `lineHeight` is that line's height, for the stem.
export interface HandlePlacement {
  readonly end: HandleEnd;
  readonly left: number;
  readonly top: number;
  readonly lineHeight: number;
}

// The handles a page shows: the start handle on the start page (at the first line's left edge), the
// end handle on the end page (at the last line's right edge). A page with no marks gets none.
export function handlePlacements(
  selection: TextSelection,
  index: PageTextIndex | undefined,
  page: number,
  zoom: number,
): HandlePlacement[] {
  const boxes = selectionMarkBoxes(selection, index, page, zoom);
  const placements: HandlePlacement[] = [];
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (first === undefined || last === undefined) return placements;
  if (page === selection.start.page) {
    placements.push({
      end: 'start',
      left: first.left,
      top: first.top + first.height,
      lineHeight: first.height,
    });
  }
  if (page === selection.end.page) {
    placements.push({
      end: 'end',
      left: last.left + last.width,
      top: last.top + last.height,
      lineHeight: last.height,
    });
  }
  return placements;
}

// The scroll a dragged handle asks for at a pointer height, given the scroller's box: up to
// AUTO_SCROLL_MAX_PX a frame, growing as the pointer nears or passes the top or bottom edge zone.
// Zero away from the edges.
export function autoScrollDelta(
  box: { readonly top: number; readonly bottom: number },
  y: number,
): number {
  const up = box.top + AUTO_SCROLL_EDGE_PX - y;
  if (up > 0)
    return -Math.min(
      AUTO_SCROLL_MAX_PX,
      Math.ceil((up / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_PX),
    );
  const down = y - (box.bottom - AUTO_SCROLL_EDGE_PX);
  if (down > 0)
    return Math.min(
      AUTO_SCROLL_MAX_PX,
      Math.ceil((down / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_PX),
    );
  return 0;
}

export interface SelectionHandlesProps {
  readonly placements: readonly HandlePlacement[];
  // Called on a handle's press. `grab` is the press's offset in CSS px from the line's middle, so
  // the caret follows the finger from where it was pressed, not from the handle's edge.
  readonly onPress: (event: ReactPointerEvent<HTMLElement>, end: HandleEnd, grab: number) => void;
}

export function SelectionHandles({ placements, onPress }: SelectionHandlesProps) {
  return (
    <>
      {placements.map((handle) => (
        <div
          key={handle.end}
          className={`selection-handle selection-handle--${handle.end}`}
          aria-hidden="true"
          style={{ left: handle.left - HANDLE_BOX_PX / 2, top: handle.top }}
          onPointerDown={(event) => {
            // The press is the handle's, not the page's: it must not clear or start a selection.
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            const middle = box.top - handle.lineHeight / 2;
            onPress(event, handle.end, event.clientY - middle);
          }}
        >
          <span
            className="selection-handle__stem"
            style={{ top: -handle.lineHeight, height: handle.lineHeight }}
          />
          <span className="selection-handle__knob" />
        </div>
      ))}
    </>
  );
}
