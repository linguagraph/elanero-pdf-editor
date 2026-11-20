import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAB_ORDER } from '../commands/registry';
import { GUIDE_URL, guideUrl, openGuide, TAB_GUIDE_PAGE, WEB_VERSION_PAGE } from './guide';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guide addresses', () => {
  it('is the published guide on the docs site', () => {
    expect(GUIDE_URL).toBe('https://linguagraph.github.io/elanero-pdf-editor/guide/');
  });

  it('gives the guide start for an empty page and the page otherwise', () => {
    expect(guideUrl()).toBe(GUIDE_URL);
    expect(guideUrl(WEB_VERSION_PAGE)).toBe(`${GUIDE_URL}web/`);
  });

  it('drops leading slashes so a page is never addressed from the host root', () => {
    expect(guideUrl('/editing/')).toBe(`${GUIDE_URL}editing/`);
  });

  it('maps every ribbon tab to a guide page that ends with a slash', () => {
    for (const tab of TAB_ORDER) {
      expect(TAB_GUIDE_PAGE[tab]).toMatch(/^[a-z-]+\/$/);
    }
  });
});

describe('openGuide', () => {
  it('opens the page in a new tab without giving the guide a handle on the app', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openGuide(TAB_GUIDE_PAGE.edit);
    expect(open).toHaveBeenCalledWith(`${GUIDE_URL}editing/`, '_blank', 'noopener,noreferrer');
  });

  it('opens the guide start with no page', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openGuide();
    expect(open).toHaveBeenCalledWith(GUIDE_URL, '_blank', 'noopener,noreferrer');
  });
});
