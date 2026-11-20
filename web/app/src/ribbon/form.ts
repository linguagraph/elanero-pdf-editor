// Which form the ribbon takes (W1.6 section 8, W4.3a S2). Pure, so the table is tested without a
// browser. The window width sets the tier; the user's own choices (compact, collapsed) apply on
// top of it and are kept in the preferences.
import type { LayoutTier } from '../layout/breakpoints';

export interface RibbonForm {
  readonly kind: 'full' | 'compact' | 'collapsed';
  // 'tier': the window is too narrow; tabs open drop-downs that close when a command runs, and
  // there is no chevron. 'user': the user collapsed it; a tab press expands it again.
  readonly collapsedBy: 'tier' | 'user' | null;
}

export interface RibbonPrefs {
  readonly compact: boolean;
  readonly collapsed: boolean;
}

export function ribbonForm(tier: LayoutTier, prefs: RibbonPrefs): RibbonForm {
  if (tier === 'tablet' || tier === 'phone') return { kind: 'collapsed', collapsedBy: 'tier' };
  if (prefs.collapsed) return { kind: 'collapsed', collapsedBy: 'user' };
  // The medium tier forces compact (W1.6 section 8); the user can ask for it at any width.
  if (tier === 'medium' || prefs.compact) return { kind: 'compact', collapsedBy: null };
  return { kind: 'full', collapsedBy: null };
}
