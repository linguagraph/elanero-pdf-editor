// The user guide's addresses (W4.3a S4). The guide is published on the docs site next to the app
// (scripts/build_site.py puts it under /guide/), so the desktop's DOCS_URL is the same address.
import type { TabId } from '../commands/registry';

export const GUIDE_URL = 'https://linguagraph.github.io/elanero-pdf-editor/guide/';

// The guide page the "?" button opens for each ribbon tab (W1.6 section 2: the page of the tab
// shown). Each value ends with a slash, the way the site's pages are addressed.
export const TAB_GUIDE_PAGE: Readonly<Record<TabId, string>> = {
  home: 'getting-started/',
  edit: 'editing/',
  organize: 'pages/',
  protect: 'security/',
  comment: 'comments/',
  view: 'reading/',
  tools: 'export/',
};

// What's Different on the Web opens the guide's "Web version" page (W9.3).
export const WEB_VERSION_PAGE = 'web/';

// The address of a guide page, or of the guide's start when no page is given.
export function guideUrl(page = ''): string {
  return GUIDE_URL + page.replace(/^\/+/, '');
}

// Opens a guide page in a new tab. Called from a press, so browsers allow the new tab.
export function openGuide(page = ''): void {
  window.open(guideUrl(page), '_blank', 'noopener,noreferrer');
}
