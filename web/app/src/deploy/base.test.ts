import { describe, expect, it } from 'vitest';
import { PRODUCTION_BASE, baseFor } from './base';

describe('base path (W9.2)', () => {
  it('is the GitHub Pages folder of the app', () => {
    expect(PRODUCTION_BASE).toBe('/elanero-pdf-editor/app/');
  });

  it('is applied to the production build only', () => {
    expect(baseFor('build')).toBe(PRODUCTION_BASE);
    expect(baseFor('serve')).toBe('/');
  });

  it('ends with a slash, so relative URLs resolve inside the folder', () => {
    expect(PRODUCTION_BASE.startsWith('/')).toBe(true);
    expect(PRODUCTION_BASE.endsWith('/')).toBe(true);
    expect(new URL('engine-assets/', `http://h${PRODUCTION_BASE}`).pathname).toBe(
      `${PRODUCTION_BASE}engine-assets/`,
    );
  });
});
