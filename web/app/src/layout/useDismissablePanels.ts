import { type RefObject, useEffect, useRef } from 'react';
import type { Side } from './sidePanels';

// Drawers and overlays (W1.6 section 8) close on Escape and on a tap outside, and move focus in
// when they open and back to their opener when they close. A docked panel stays open: it only
// takes part in Escape, which moves focus to the page (desktop escape_pressed).

const SIDES: readonly Side[] = ['left', 'right'];

// Taps on these are not "outside": react-aria popovers and menus are portalled to the body, and
// the overlay dialogs sit on top of the whole frame.
const TOP_LAYER = '[data-react-aria-top-layer], .app-menu-popover, .overlay-backdrop';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DismissablePanelsOptions {
  // The region frame, which holds the rails and the panels.
  readonly frame: RefObject<HTMLElement | null>;
  // Whether a panel node is shown on each side.
  readonly shown: Readonly<Record<Side, boolean>>;
  // Whether that side's panel floats (drawer or overlay) at the current tier.
  readonly floating: Readonly<Record<Side, boolean>>;
  readonly onDismiss?: ((side: Side) => void) | undefined;
}

function panelOf(frame: HTMLElement, side: Side): HTMLElement | null {
  return frame.querySelector<HTMLElement>(`.app-panel-${side}`);
}

function railOf(frame: HTMLElement, side: Side): HTMLElement | null {
  return frame.querySelector<HTMLElement>(`.app-rail-${side}`);
}

export function useDismissablePanels(options: DismissablePanelsOptions): void {
  // The listeners are attached once; they read the latest values from here.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // Focus moves into a floating panel when it opens, unless focus is already in it (the search
  // panel focuses its own query box). Runs after every render; it only acts on an opening.
  const wasOpen = useRef<Record<Side, boolean>>({ left: false, right: false });
  useEffect(() => {
    const frame = options.frame.current;
    for (const side of SIDES) {
      const open = options.shown[side] && options.floating[side];
      if (open && !wasOpen.current[side] && frame) {
        const panel = panelOf(frame, side);
        if (panel && !panel.contains(document.activeElement)) {
          panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        }
      }
      wasOpen.current[side] = open;
    }
  });

  useEffect(() => {
    // Closes a side. On Escape, focus goes back to the rail button that opened the panel, when
    // focus was inside it; a tap outside keeps whatever the tap focused.
    const dismiss = (side: Side, restoreFocus: boolean) => {
      const { frame, onDismiss } = latest.current;
      const root = frame.current;
      const panel = root ? panelOf(root, side) : null;
      const focusWasInside = panel?.contains(document.activeElement) ?? false;
      const opener =
        restoreFocus && focusWasInside && root
          ? railOf(root, side)?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
          : null;
      onDismiss?.(side);
      opener?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const { frame, shown, floating } = latest.current;
      const root = frame.current;
      // An open dialog owns Escape.
      if (!root || document.querySelector('.overlay-backdrop')) return;

      const active = document.activeElement;
      const sideWithFocus = SIDES.find(
        (side) => shown[side] && (panelOf(root, side)?.contains(active) ?? false),
      );
      if (sideWithFocus !== undefined) {
        if (floating[sideWithFocus]) {
          event.preventDefault();
          dismiss(sideWithFocus, true);
        } else {
          // Docked: Escape leaves the panel for the page, and the panel stays open.
          const page = root.querySelector<HTMLElement>('.doc-view-scroll');
          if (page) {
            event.preventDefault();
            page.focus();
          }
        }
        return;
      }
      // Focus is elsewhere: Escape closes the floating panels.
      let handled = false;
      for (const side of SIDES) {
        if (shown[side] && floating[side]) {
          dismiss(side, false);
          handled = true;
        }
      }
      if (handled) event.preventDefault();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(TOP_LAYER)) return;
      const { frame, shown, floating } = latest.current;
      const root = frame.current;
      if (!root) return;
      for (const side of SIDES) {
        if (!shown[side] || !floating[side]) continue;
        // A tap on the panel or on its own rail is not outside.
        if (panelOf(root, side)?.contains(target) || railOf(root, side)?.contains(target)) {
          continue;
        }
        dismiss(side, false);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);
}
