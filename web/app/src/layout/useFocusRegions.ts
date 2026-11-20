import { useEffect, useRef } from 'react';
import { nextRegion, REGION_ORDER, regionOf, type RegionName } from './focusRegions';

// Elements that can take the keyboard. Disabled controls and hidden subtrees are filtered out.
const FOCUSABLE =
  'button, [href], input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// Dialogs and modal backdrops are portaled outside every region. While one is open, F6 leaves the
// keyboard alone so the dialog keeps its own focus trap (W1.6 section 5).
const MODAL = '[role="dialog"], [aria-modal="true"], .overlay-backdrop';

// A region is the set of containers marked data-region with its name (the rail and the panel of a
// side share "left"). The page area is a container with tabindex -1, so it is a stop even with no
// control inside it.
function containersOf(name: RegionName): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-region="${name}"]`));
}

function reachable(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false;
  if (element.closest('fieldset:disabled')) return false;
  if (element.hasAttribute('disabled')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (window.getComputedStyle(node).display === 'none') return false;
  }
  // Visibility is inherited, so the element's own computed value covers its ancestors too, and a
  // descendant that sets visibility: visible is shown, as the browser shows it.
  if (window.getComputedStyle(element).visibility === 'hidden') return false;
  return true;
}

// The page area as a stop of its own: a container with tabindex -1 that is shown.
function pageAreaOf(containers: readonly HTMLElement[]): HTMLElement | null {
  // Read the attribute: a plain div reports tabIndex -1 too, which is not a stop of its own.
  return (
    containers.find(
      (container) => container.getAttribute('tabindex') === '-1' && reachable(container),
    ) ?? null
  );
}

function focusablesIn(containers: readonly HTMLElement[]): HTMLElement[] {
  return containers.flatMap((container) =>
    Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(reachable),
  );
}

// The entry point of a region: the element it remembered when the keyboard left it (if still
// there), else its first reachable control, else its own container (the page area).
function entryOf(name: RegionName, remembered: HTMLElement | undefined): HTMLElement | null {
  const containers = containersOf(name);
  if (remembered?.isConnected && reachable(remembered)) {
    if (containers.some((container) => container.contains(remembered))) return remembered;
  }
  const first = focusablesIn(containers)[0];
  if (first) return first;
  return pageAreaOf(containers);
}

// Moves focus to the document for the skip link: the canvas scroller when the page shows one, else
// the page area itself. The page area's first control (a view toolbar button) is not the document,
// so it is not used here.
export function focusDocument(): boolean {
  const pages = containersOf('page');
  const scrollers: HTMLElement[] = [];
  for (const page of pages) {
    scrollers.push(...Array.from(page.querySelectorAll<HTMLElement>('.doc-view-scroll')));
  }
  const target = scrollers.find(reachable) ?? pageAreaOf(pages);
  if (!target) return false;
  target.focus();
  return true;
}

// The regions that have something to take the keyboard right now.
function presentRegions(): RegionName[] {
  return REGION_ORDER.filter((name) => entryOf(name, undefined) !== null);
}

// Window-level F6 / Shift+F6, in the capture phase so it wins over the page's own handlers. It
// cycles even from inside a text field (desktop behaviour) and prevents the default, since browsers
// may use F6 for the address bar. With a dialog open it does nothing at all, default included.
export function useFocusRegions(): void {
  const remembered = useRef(new Map<RegionName, HTMLElement>());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.ctrlKey || event.altKey || event.metaKey) return;
      if (document.querySelector(MODAL) !== null) return;
      event.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      const here = regionOf(active?.closest<HTMLElement>('[data-region]')?.dataset.region);
      if (here && active) remembered.current.set(here, active);

      const next = nextRegion(presentRegions(), here, event.shiftKey ? -1 : 1);
      if (next === null || next === here) return;
      entryOf(next, remembered.current.get(next))?.focus();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
