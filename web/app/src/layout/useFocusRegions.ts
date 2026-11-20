import { useEffect, useRef } from 'react';
import { nextRegion, REGION_ORDER, regionOf, type RegionName } from './focusRegions';

// Elements that can take the keyboard. Disabled controls and hidden subtrees are filtered out.
const FOCUSABLE =
  'button, [href], input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

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
  return true;
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
  // Read the attribute: a plain div reports tabIndex -1 too, which is not a stop of its own.
  return containers.find((container) => container.getAttribute('tabindex') === '-1') ?? null;
}

// Moves focus to a region's entry point. The skip link uses it to reach the page area.
export function focusRegion(name: RegionName): boolean {
  const target = entryOf(name, undefined);
  if (!target) return false;
  target.focus();
  return true;
}

// The regions that have something to take the keyboard right now.
function presentRegions(): RegionName[] {
  return REGION_ORDER.filter((name) => entryOf(name, undefined) !== null);
}

// Window-level F6 / Shift+F6, in the capture phase so it wins over the page's own handlers. It
// cycles even from inside a text field (desktop behaviour) and always prevents the default, since
// browsers may use F6 for the address bar.
export function useFocusRegions(): void {
  const remembered = useRef(new Map<RegionName, HTMLElement>());

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.ctrlKey || event.altKey || event.metaKey) return;
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
