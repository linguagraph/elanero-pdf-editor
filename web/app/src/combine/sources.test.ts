import { describe, expect, it } from 'vitest';
import {
  addSources,
  isImageSourceName,
  isSupportedSourceName,
  moveSource,
  outputFileName,
  removeSource,
  setSourcePages,
  type SourceItem,
} from './sources';

function file(name: string): File {
  return new File(['x'], name, { type: 'application/octet-stream' });
}

function item(id: number, name: string): SourceItem {
  return { id, name, file: file(name), pages: '' };
}

function names(items: readonly SourceItem[]): string[] {
  return items.map((entry) => entry.name);
}

describe('source list', () => {
  it('accepts PDF and image names, in any letter case, and refuses the rest', () => {
    expect(isSupportedSourceName('a.pdf')).toBe(true);
    expect(isSupportedSourceName('SCAN.PNG')).toBe(true);
    expect(isSupportedSourceName('photo.jpeg')).toBe(true);
    expect(isSupportedSourceName('notes.docx')).toBe(false);
    expect(isSupportedSourceName('noextension')).toBe(false);
  });

  it('adds supported files in the order given and reports the rest by name', () => {
    const start = [item(1, 'a.pdf')];
    const added = addSources(start, [file('b.png'), file('c.txt'), file('d.pdf')], 2);

    expect(names(added.items)).toEqual(['a.pdf', 'b.png', 'd.pdf']);
    expect(added.items.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(added.rejected).toEqual(['c.txt']);
    expect(names(start)).toEqual(['a.pdf']); // the input list is not changed
  });

  it('moves an item up and down, and does nothing past either end', () => {
    const list = [item(1, 'a.pdf'), item(2, 'b.pdf'), item(3, 'c.pdf')];

    expect(names(moveSource(list, 2, -1))).toEqual(['a.pdf', 'c.pdf', 'b.pdf']);
    expect(names(moveSource(list, 0, 1))).toEqual(['b.pdf', 'a.pdf', 'c.pdf']);
    expect(moveSource(list, 0, -1)).toBe(list);
    expect(moveSource(list, 2, 1)).toBe(list);
  });

  it('removes one item and keeps the order of the rest', () => {
    const list = [item(1, 'a.pdf'), item(2, 'b.pdf'), item(3, 'c.pdf')];

    expect(names(removeSource(list, 1))).toEqual(['a.pdf', 'c.pdf']);
    expect(removeSource(list, 9)).toBe(list);
  });

  it('keeps the order through a sequence of moves and removes', () => {
    let list = addSources([], [file('1.pdf'), file('2.pdf'), file('3.pdf')], 1).items;
    list = moveSource(list, 2, -1); // 1, 3, 2
    list = moveSource(list, 0, 1); // 3, 1, 2
    list = removeSource(list, 0); // 1, 2
    expect(names(list)).toEqual(['1.pdf', '2.pdf']);
  });
});

describe('output name', () => {
  it('defaults to merged.pdf and adds .pdf when it is missing', () => {
    expect(outputFileName('')).toBe('merged.pdf');
    expect(outputFileName('   ')).toBe('merged.pdf');
    expect(outputFileName('report')).toBe('report.pdf');
    expect(outputFileName(' report.PDF ')).toBe('report.PDF');
  });
});

describe('page ranges per source', () => {
  it('starts every row with an empty Pages box, which means every page', () => {
    const { items } = addSources([], [file('a.pdf')], 1);
    expect(items[0]?.pages).toBe('');
  });

  it('sets the box of one row and keeps it through a move, and drops it with the row', () => {
    const { items } = addSources([], [file('a.pdf'), file('b.pdf')], 1);
    const typed = setSourcePages(items, 1, '2-3');
    expect(typed.map((entry) => entry.pages)).toEqual(['2-3', '']);
    const moved = moveSource(typed, 0, 1);
    expect(moved.map((entry) => [entry.name, entry.pages])).toEqual([
      ['b.pdf', ''],
      ['a.pdf', '2-3'],
    ]);
    expect(removeSource(moved, 1).map((entry) => entry.pages)).toEqual(['']);
  });

  it('tells an image name from a PDF name', () => {
    expect(isImageSourceName('scan.PNG')).toBe(true);
    expect(isImageSourceName('a.pdf')).toBe(false);
    expect(isImageSourceName('noextension')).toBe(false);
  });
});
