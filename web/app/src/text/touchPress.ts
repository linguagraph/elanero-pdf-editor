// The long-press gesture of a touch or pen press under the Select tool (W5.4 S1, design section 2).
// A press on text waits: a hold of LONG_PRESS_MS that stays within TOUCH_SLOP_PX selects the word
// under the press; a move past the slop is a scroll, and a lift before the hold is a tap. The machine
// is pure: the hook feeds it the pointer events and the timer, and runs the effect it returns.
// Pure so the transitions are tested without a DOM (touchPress.test.ts).
import { CSS_PX_PER_POINT } from '../view/zoom';

// Android's default long-press timeout: what users of the native selection expect (section 2).
export const LONG_PRESS_MS = 500;
// A move past this many CSS px from the press is a scroll, not a hold (the Chromium touch slop).
export const TOUCH_SLOP_PX = 8;
// The touch hit tolerance: a fingertip covers more than a glyph (the mouse keeps 4 pt).
export const TOUCH_HIT_PX = 12;

// The hit tolerance in points at a zoom, for PageTextIndex.hitTest.
export function touchHitPoints(zoom: number): number {
  return TOUCH_HIT_PX / (zoom * CSS_PX_PER_POINT);
}

export type TouchGesture =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'pending';
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly phase: 'selecting'; readonly pointerId: number };

export const IDLE: TouchGesture = { phase: 'idle' };

export type TouchInput =
  // A touch or pen pointer went down. `onText` is whether it landed on text within the tolerance.
  | {
      readonly type: 'press';
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      readonly onText: boolean;
    }
  // Another touch pointer went down while a gesture runs (a pinch).
  | { readonly type: 'second' }
  | { readonly type: 'move'; readonly pointerId: number; readonly x: number; readonly y: number }
  | { readonly type: 'up'; readonly pointerId: number }
  | { readonly type: 'cancel'; readonly pointerId: number }
  // The LONG_PRESS_MS timer fired for the pending press.
  | { readonly type: 'timer' }
  // The browser's long-press menu was requested (it can come before the timer on some platforms).
  | { readonly type: 'contextmenu' };

// What the hook does on a transition. `arm` starts the timer and the press's listeners; `selectWord`
// selects the word under the press; `extend` moves the focus of a selection to the pointer; `tap`
// clears the selection (a lift before the hold); `end` finishes a selection (announced); `stop`
// ends a gesture that leaves the selection as it was (a scroll, a cancel, a pinch).
export type TouchEffect = 'none' | 'arm' | 'selectWord' | 'extend' | 'tap' | 'end' | 'stop';

export interface TouchStep {
  readonly gesture: TouchGesture;
  readonly effect: TouchEffect;
}

export function stepTouch(gesture: TouchGesture, input: TouchInput): TouchStep {
  const keep: TouchStep = { gesture, effect: 'none' };
  switch (gesture.phase) {
    case 'idle':
      if (input.type === 'press' && input.onText) {
        return {
          gesture: { phase: 'pending', pointerId: input.pointerId, x: input.x, y: input.y },
          effect: 'arm',
        };
      }
      return keep;
    case 'pending':
      switch (input.type) {
        case 'second':
          return { gesture: IDLE, effect: 'stop' };
        case 'move':
          if (input.pointerId !== gesture.pointerId) return keep;
          if (Math.hypot(input.x - gesture.x, input.y - gesture.y) <= TOUCH_SLOP_PX) return keep;
          return { gesture: IDLE, effect: 'stop' };
        case 'up':
          if (input.pointerId !== gesture.pointerId) return keep;
          return { gesture: IDLE, effect: 'tap' };
        case 'cancel':
          if (input.pointerId !== gesture.pointerId) return keep;
          return { gesture: IDLE, effect: 'stop' };
        case 'timer':
        case 'contextmenu':
          return {
            gesture: { phase: 'selecting', pointerId: gesture.pointerId },
            effect: 'selectWord',
          };
        default:
          return keep;
      }
    case 'selecting':
      switch (input.type) {
        case 'second':
          return { gesture: IDLE, effect: 'stop' };
        case 'move':
          return input.pointerId === gesture.pointerId ? { gesture, effect: 'extend' } : keep;
        case 'up':
          return input.pointerId === gesture.pointerId ? { gesture: IDLE, effect: 'end' } : keep;
        case 'cancel':
          return input.pointerId === gesture.pointerId ? { gesture: IDLE, effect: 'stop' } : keep;
        default:
          return keep;
      }
  }
}
