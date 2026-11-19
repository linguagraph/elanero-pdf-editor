import { describe, expect, it } from 'vitest';
import { extractName } from './extract';

describe('extract file name', () => {
  it('adds " (extract)" before the .pdf suffix, as the desktop does', () => {
    expect(extractName('Dryer.pdf')).toBe('Dryer (extract).pdf');
    expect(extractName('Report.PDF')).toBe('Report (extract).pdf');
  });

  it('adds the suffix to a name with no .pdf ending', () => {
    expect(extractName('scan')).toBe('scan (extract).pdf');
  });
});
