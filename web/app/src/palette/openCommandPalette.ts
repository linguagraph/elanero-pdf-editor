// The palette is opened from elsewhere (the ribbon's Search tools box, the keyboard shortcuts
// entry) through a window event, so the callers need no reference to the palette's state. The
// seed is optional: a query starts the palette filtered, and a view picks the commands list or the
// shortcuts list.

export type PaletteView = 'commands' | 'shortcuts';

export interface PaletteSeed {
  query?: string;
  view?: PaletteView;
}

export const OPEN_COMMAND_PALETTE_EVENT = 'elanero:open-command-palette';

export function openCommandPalette(seed: PaletteSeed = {}): void {
  window.dispatchEvent(new CustomEvent<PaletteSeed>(OPEN_COMMAND_PALETTE_EVENT, { detail: seed }));
}
