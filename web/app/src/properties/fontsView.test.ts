// The Fonts tab's labels and page text (W7.6 slice B). The range text is replayed against the
// desktop's answers in web/test/vectors/font-pages.json (made by scripts/make_web_vectors.py).
import { describe, expect, it } from 'vitest';
import rawVectors from '../../../test/vectors/font-pages.json';
import { embeddingLabel, pageRangeText } from './fontsView';

interface VectorCase {
  readonly pages: readonly number[];
  readonly text: string;
}

const cases = (rawVectors as { readonly cases: readonly VectorCase[] }).cases;

describe('the embedding label of a font', () => {
  it('reads "Embedded subset" for a subset, "Embedded" for a whole font, else "Not embedded"', () => {
    expect(embeddingLabel({ embedded: true, subset: true })).toBe('properties.fonts.subset');
    expect(embeddingLabel({ embedded: true, subset: false })).toBe('properties.fonts.embedded');
    expect(embeddingLabel({ embedded: false, subset: false })).toBe('properties.fonts.notEmbedded');
  });

  it('checks the subset flag first, as the desktop does', () => {
    expect(embeddingLabel({ embedded: false, subset: true })).toBe('properties.fonts.subset');
  });
});

describe('the page text of a font', () => {
  it('has the desktop cases', () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  for (const vector of cases) {
    it(`agrees with the desktop for pages ${JSON.stringify(vector.pages)}`, () => {
      expect(pageRangeText(vector.pages)).toBe(vector.text);
    });
  }

  it('shows 0-based pages 1-based, with runs joined by a dash', () => {
    expect(pageRangeText([0, 1, 2, 6])).toBe('1-3, 7');
    expect(pageRangeText([])).toBe('');
  });
});
