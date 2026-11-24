// Keyboard use of the comment tools and of the comments on a page (W7.1a slice 9). Enter places a
// tool's default comment at the centre of the page (the same sizes the desktop's defaults use);
// arrow keys move a selected comment by 1 pt (Shift: 10 pt), and Alt with an arrow resizes its
// bottom-right corner by the same steps. Each press is one annotations.transform; the presses of a
// hold share a merge_key, so the engine makes them one undo step (W7.1a section 3.5).
import type { RectDto } from '../rpc/generated';
import { MIN_SIZE } from '../edit/hitTest';
import type { PagePoint, PageRect } from './coordinates';
import { boundsOf } from './pointGeometry';
import { GESTURE_KIND, type CommentToolId } from './tools';
import type { CommentRef } from './hitTest';

// The default sizes Enter places (points): a box, a line's length, and a callout's tip gap.
export const PLACE_BOX_W_PT = 100;
export const PLACE_BOX_H_PT = 60;
export const PLACE_LINE_PT = 100;
export const CALLOUT_TIP_GAP_PT = 40;

export const NUDGE_STEP_PT = 1;
export const NUDGE_LARGE_PT = 10;

// A pause this long between two presses of one comment starts a new step, even with no keyup
// (a key held down repeats fast, so a pause is a new press).
export const HOLD_GAP_MS = 500;

// What Enter does with a tool: a comment placed at once, or a text form opened over a box (its
// tip, for a callout). Null for the tools with no keyboard placement (pen, polygon, polyline) and
// for a stamp, which has its own Enter.
export type KeyPlacement =
  | { readonly kind: 'place'; readonly rect: PageRect; readonly points: readonly PagePoint[] }
  | { readonly kind: 'text'; readonly rect: PageRect; readonly tip: PagePoint | null };

// The default placement of a tool at the centre of a page of the given size.
export function centredPlacement(
  tool: CommentToolId,
  widthPt: number,
  heightPt: number,
): KeyPlacement | null {
  const cx = widthPt / 2;
  const cy = heightPt / 2;
  const box: PageRect = {
    x0: cx - PLACE_BOX_W_PT / 2,
    y0: cy - PLACE_BOX_H_PT / 2,
    x1: cx + PLACE_BOX_W_PT / 2,
    y1: cy + PLACE_BOX_H_PT / 2,
  };
  switch (GESTURE_KIND[tool]) {
    case 'click':
      // A note opens its form at the centre, as a click does.
      return { kind: 'text', rect: { x0: cx, y0: cy, x1: cx, y1: cy }, tip: null };
    case 'text':
      return { kind: 'text', rect: box, tip: null };
    case 'callout':
      return { kind: 'text', rect: box, tip: { x: box.x0 - CALLOUT_TIP_GAP_PT, y: cy } };
    case 'box':
      return { kind: 'place', rect: box, points: [] };
    case 'line': {
      const a = { x: cx - PLACE_LINE_PT / 2, y: cy };
      const b = { x: cx + PLACE_LINE_PT / 2, y: cy };
      return { kind: 'place', rect: boundsOf([a, b]), points: [a, b] };
    }
    default:
      return null;
  }
}

// The step an arrow key moves by, or null for another key.
export function arrowStep(
  key: string,
  shift: boolean,
): { readonly dx: number; readonly dy: number } | null {
  const s = shift ? NUDGE_LARGE_PT : NUDGE_STEP_PT;
  switch (key) {
    case 'ArrowLeft':
      return { dx: -s, dy: 0 };
    case 'ArrowRight':
      return { dx: s, dy: 0 };
    case 'ArrowUp':
      return { dx: 0, dy: -s };
    case 'ArrowDown':
      return { dx: 0, dy: s };
    default:
      return null;
  }
}

// The merge_key of a press. The hold number (NudgeQueue.press) makes each hold its own step, so a
// press after a keyup or a pause never merges into the one before. A move and a resize of one
// comment are different steps, so they differ too.
export function nudgeMergeKey(ref: CommentRef, hold: number, resize: boolean): string {
  return `nudge:${ref.page}:${ref.name}:${hold}${resize ? ':resize' : ''}`;
}

// The box after a move by (dx, dy).
export function movedBox(box: RectDto, dx: number, dy: number): RectDto {
  return { x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy };
}

// The box after the bottom-right corner moves by (dx, dy), never shorter than MIN_SIZE.
export function resizedCornerBox(box: RectDto, dx: number, dy: number): RectDto {
  return {
    x0: box.x0,
    y0: box.y0,
    x1: Math.max(box.x1 + dx, box.x0 + MIN_SIZE),
    y1: Math.max(box.y1 + dy, box.y0 + MIN_SIZE),
  };
}

// Sends the presses of a hold one after another. A press waits for the one before it, so only one
// annotations.transform is in flight. The box a comment is at is kept while presses queue: the
// page's list is read again only after the queue drains, so a press builds on the last one sent.
// reset() drops the presses still waiting (a stale comment, or the page changed under the hold).
export class NudgeQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private epoch = 0;
  private readonly boxes = new Map<string, RectDto>();
  // Per comment: the number of its current hold, when its last press was, and whether the arrow
  // key was released since (a keyup ends the hold).
  private readonly holds = new Map<string, { n: number; at: number; released: boolean }>();

  // The hold a press of a comment belongs to, for its merge_key. A press keeps the hold of the one
  // before it, unless the key was released or more than HOLD_GAP_MS passed since that press.
  press(name: string, now: number = Date.now()): number {
    const hold = this.holds.get(name);
    const same = hold !== undefined && !hold.released && now - hold.at <= HOLD_GAP_MS;
    const n = same ? hold.n : (hold?.n ?? 0) + 1;
    this.holds.set(name, { n, at: now, released: false });
    return n;
  }

  // The arrow key was released: the next press of the comment starts a new hold.
  release(name: string): void {
    const hold = this.holds.get(name);
    if (hold !== undefined) hold.released = true;
  }

  // The box a comment is at after the presses sent so far, else the fallback (its listed bounds).
  boxOf(name: string, fallback: RectDto): RectDto {
    return this.boxes.get(name) ?? fallback;
  }

  setBox(name: string, box: RectDto): void {
    this.boxes.set(name, box);
  }

  // Whether no press is waiting or in flight.
  idle(): boolean {
    return this.pending === 0;
  }

  // Forgets the boxes kept for the holds (the list was read again, so its bounds are current).
  clearBoxes(): void {
    this.boxes.clear();
  }

  // Queues one press. The step runs after the presses before it; a press queued before reset()
  // is skipped.
  enqueue(step: () => Promise<boolean>): void {
    this.pending += 1;
    const epoch = this.epoch;
    this.tail = this.tail.then(async () => {
      try {
        // transform.ts reports its own failures; a throw here must not end the chain.
        if (epoch === this.epoch) await step().catch(() => false);
      } finally {
        this.pending -= 1;
      }
    });
  }

  reset(): void {
    this.epoch += 1;
    this.boxes.clear();
  }
}
