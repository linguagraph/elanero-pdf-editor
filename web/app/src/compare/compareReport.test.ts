import { describe, expect, it } from 'vitest';
import { t, tp } from '../i18n/t';
import type { CompareChange, CompareReport } from './compareJob';
import { groupChanges, kindLabel, reportText } from './compareReport';

const CHANGES: CompareChange[] = [
  { kind: 'replaced', pageA: 0, pageB: 0, summary: "'old' -> 'new'" },
  { kind: 'inserted', pageA: 0, pageB: 0, summary: 'a new line' },
  { kind: 'page inserted', pageA: null, pageB: 2, summary: 'page 3 added' },
  { kind: 'visual', pageA: 4, pageB: 4, summary: 'pixels differ' },
];

const REPORT: CompareReport = {
  identical: false,
  pairs: [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, null],
    [4, 4],
  ],
  changes: CHANGES,
};

describe('groupChanges', () => {
  it('groups the changes by the page they are on, in the order the job gave them', () => {
    const pages = groupChanges(CHANGES);
    expect(pages.map((page) => [page.pageA, page.pageB])).toEqual([
      [0, 0],
      [null, 2],
      [4, 4],
    ]);
    expect(pages[0]?.changes.map((change) => change.kind)).toEqual(['replaced', 'inserted']);
  });

  it('has no pages when nothing changed', () => {
    expect(groupChanges([])).toEqual([]);
  });
});

describe('kindLabel', () => {
  it('names the known kinds in words', () => {
    expect(kindLabel('replaced')).toBe(t('compare.kind.replaced'));
    expect(kindLabel('page inserted')).toBe(t('compare.kind.pageInserted'));
  });

  it('shows a kind it does not know as the job names it', () => {
    expect(kindLabel('moved')).toBe('moved');
  });
});

describe('reportText', () => {
  it('lists the documents, the page counts and each changed page with its changes', () => {
    const text = reportText(REPORT, 'Old.pdf', 'New.pdf');
    expect(text).toContain(t('compare.report.older', { name: 'Old.pdf' }));
    expect(text).toContain(t('compare.report.newer', { name: 'New.pdf' }));
    expect(text).toContain(tp('compare.report.summary', 5, { changed: 3 }));
    expect(text).toContain(t('compare.report.page', { page: 1 }));
    expect(text).toContain(`${t('compare.kind.replaced')}: 'old' -> 'new'`);
    expect(text).toContain(`${t('compare.kind.inserted')}: a new line`);
    expect(text).toContain(t('compare.report.pageNewOnly', { page: 3 }));
    expect(text).toContain(`${t('compare.kind.visual')}: pixels differ`);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('says so when the documents are identical', () => {
    const text = reportText({ identical: true, pairs: [[0, 0]], changes: [] }, 'a.pdf', 'b.pdf');
    expect(text).toContain(t('compare.report.identical'));
    expect(text).not.toContain(t('compare.report.page', { page: 1 }));
  });
});
