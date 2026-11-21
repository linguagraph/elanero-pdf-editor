// The tap rule for links (W5.3). The scroller's pan capture sends the click to the scroller, not to
// the link, so a link is followed by its pointer-up: a press that moved at most a few CSS pixels is
// a tap, and a longer drag was a pan and follows nothing. Pure, so it is tested without a DOM.

// How far the pointer may move between press and release and still count as a tap, in CSS pixels.
export const LINK_TAP_SLOP = 4;

// A press on a link: which pointer, where it started, and which link (its page and its index in
// the page's sorted list).
export interface LinkPress {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly page: number;
  readonly index: number;
}

// Whether a release is the end of a tap on the press's link.
export function isTap(press: LinkPress, pointerId: number, x: number, y: number): boolean {
  if (press.pointerId !== pointerId) return false;
  return Math.abs(x - press.x) <= LINK_TAP_SLOP && Math.abs(y - press.y) <= LINK_TAP_SLOP;
}
