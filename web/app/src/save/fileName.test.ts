import { describe, expect, it } from 'vitest';
import { pdfFileName } from './fileName';

describe('pdfFileName', () => {
  it('appends the .pdf suffix when it is missing and keeps it when present', () => {
    expect(pdfFileName('report', 'Document')).toBe('report.pdf');
    expect(pdfFileName('report.pdf', 'Document')).toBe('report.pdf');
    expect(pdfFileName('report.PDF', 'Document')).toBe('report.PDF');
  });

  it('keeps the name the user chose, including a space and a number in brackets', () => {
    expect(pdfFileName('report (1).pdf', 'Document')).toBe('report (1).pdf');
    expect(pdfFileName('Dryer UM HALSNER EN.pdf', 'Document')).toBe('Dryer UM HALSNER EN.pdf');
  });

  it('removes the characters a file system refuses and trims the ends', () => {
    expect(pdfFileName('  a/b\\c:d*e?f"g<h>i|j.pdf  ', 'Document')).toBe('abcdefghij.pdf');
    expect(pdfFileName('tab\tname', 'Document')).toBe('tabname.pdf');
  });

  it('keeps Unicode letters', () => {
    expect(pdfFileName('Отчёт 2026', 'Document')).toBe('Отчёт 2026.pdf');
  });

  it('uses the fallback when the name is blank or only refused characters', () => {
    expect(pdfFileName('   ', 'Document')).toBe('Document.pdf');
    expect(pdfFileName('///', 'Document')).toBe('Document.pdf');
  });
});
