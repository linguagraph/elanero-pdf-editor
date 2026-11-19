// Drag-and-drop reorder of the page organizer (W6.1), pure so the rules are tested without a DOM.
// The engine stays the authority: a drop ends in one pages.move call, and moveOrder only predicts
// whether that call would change anything.

// A grid cell's box in scroll-content coordinates, taken once at drag start.
export interface CellBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

// Where a drop lands: `before` is pages.move's argument (0..count, original numbering). `marker`
// is the cell edge that shows the line; the end of a row and the start of the next row are the
// same `before` but different markers, so the line follows the pointer.
export interface DropSlot {
  readonly before: number;
  readonly marker: { readonly index: number; readonly side: 'before' | 'after' } | null;
}

// Cells whose tops differ by less than this are one row (fractional layouts).
const ROW_TOLERANCE_PX = 1;

// Port of desktop ui/organizer/organizer.py insertion_slot. `cells[i]` is page i.
export function dropSlot(cells: readonly CellBox[], x: number, y: number): DropSlot {
  if (cells.length === 0) return { before: 0, marker: null };

  const rows: number[][] = [];
  let rowTop = Number.NaN;
  cells.forEach((cell, index) => {
    const current = rows[rows.length - 1];
    if (current === undefined || Math.abs(cell.top - rowTop) >= ROW_TOLERANCE_PX) {
      rows.push([index]);
      rowTop = cell.top;
    } else {
      current.push(index);
    }
  });

  // The first row whose bottom is below the pointer; a pointer above the grid gets the first row,
  // one below it the last.
  const row = rows.find((members) => {
    const bottom = Math.max(...members.map((index) => cells[index]?.bottom ?? 0));
    return y < bottom;
  }) ?? rows[rows.length - 1] ?? [];

  const ordered = [...row].sort((a, b) => (cells[a]?.left ?? 0) - (cells[b]?.left ?? 0));
  for (const index of ordered) {
    const cell = cells[index];
    if (cell !== undefined && (cell.left + cell.right) / 2 > x) {
      return { before: index, marker: { index, side: 'before' } };
    }
  }
  const last = ordered[ordered.length - 1] ?? 0;
  return { before: last + 1, marker: { index: last, side: 'after' } };
}

// The pages a drag carries: the whole selection when the pressed page is in it, else just that page.
export function draggedPages(picked: readonly number[], pressed: number): readonly number[] {
  if (!picked.includes(pressed)) return [pressed];
  return [...picked].sort((a, b) => a - b);
}

// Mirrors pages.move (services/pages.py move_order): the new order for `pages` placed before
// `before`, and the moved pages' new indexes.
export function moveOrder(
  count: number,
  pages: readonly number[],
  before: number,
): { readonly order: readonly number[]; readonly placed: readonly number[] } {
  const moving = [...new Set(pages)].sort((a, b) => a - b);
  const rest: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (!moving.includes(i)) rest.push(i);
  }
  const insertAt = rest.filter((index) => index < before).length;
  const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
  const placed = moving.map((_, offset) => insertAt + offset);
  return { order, placed };
}

// False when the drop would leave the order as it is (pages.move would answer executed=false):
// the panel then sends nothing.
export function changesOrder(count: number, pages: readonly number[], before: number): boolean {
  return moveOrder(count, pages, before).order.some((page, position) => page !== position);
}

export const DRAG_THRESHOLD_PX = 5;

// A press becomes a drag only after the pointer has moved this far, so a plain click still selects.
export function passedThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

export const AUTO_SCROLL_EDGE_PX = 40;
export const AUTO_SCROLL_MAX_PX = 16;

// Auto-scroll step for one animation frame: negative near the top edge, positive near the bottom,
// 0 elsewhere. It grows linearly from 0 at the inner edge of the band to the maximum at the edge.
export function autoScrollStep(y: number, top: number, bottom: number): number {
  const nearTop = (top + AUTO_SCROLL_EDGE_PX - y) / AUTO_SCROLL_EDGE_PX;
  if (nearTop > 0) return -AUTO_SCROLL_MAX_PX * Math.min(nearTop, 1);
  const nearBottom = (y - (bottom - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX;
  if (nearBottom > 0) return AUTO_SCROLL_MAX_PX * Math.min(nearBottom, 1);
  return 0;
}
