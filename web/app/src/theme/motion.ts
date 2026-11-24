// The Reduce motion preference (W8.5 S6). The switch in Preferences sets `data-reduce-motion` on
// the root element, and motion.css turns animations off under that attribute, the same way the
// system setting does. The preference is stored with the other preferences; it is not a secret.
import { readPreferences } from '../prefs/store';

export const REDUCE_MOTION_ATTRIBUTE = 'data-reduce-motion';

export function applyReduceMotion(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) {
    root.setAttribute(REDUCE_MOTION_ATTRIBUTE, 'true');
  } else {
    root.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
  }
}

// Applies the saved choice before the first render, so motion does not run once before it stops.
// readPreferences never throws (a throwing localStorage gives the defaults), so this cannot fail.
export function initReduceMotion(): boolean {
  const on = readPreferences().reduceMotion;
  applyReduceMotion(on);
  return on;
}
