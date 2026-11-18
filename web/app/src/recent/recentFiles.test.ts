import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSecretKey } from '../prefs/store';
import {
  addRecentFile,
  cleanRecentName,
  readRecentFiles,
  RECENT_LIMIT,
  RECENT_NAME_MAX_LENGTH,
  RECENT_STORAGE_KEY,
  writeRecentFiles,
} from './recentFiles';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('recent files round trip', () => {
  it('reads back the name and the time of each opened file', () => {
    addRecentFile('report.pdf', 1000);
    expect(readRecentFiles()).toEqual([{ name: 'report.pdf', openedAt: 1000 }]);
  });

  it('lists the newest first', () => {
    addRecentFile('a.pdf', 1000);
    addRecentFile('b.pdf', 3000);
    addRecentFile('c.pdf', 2000);
    expect(readRecentFiles().map((entry) => entry.name)).toEqual(['b.pdf', 'c.pdf', 'a.pdf']);
  });

  it('moves a file that is opened again to the top, with one entry per name', () => {
    addRecentFile('a.pdf', 1000);
    addRecentFile('b.pdf', 2000);
    addRecentFile('a.pdf', 3000);
    expect(readRecentFiles()).toEqual([
      { name: 'a.pdf', openedAt: 3000 },
      { name: 'b.pdf', openedAt: 2000 },
    ]);
  });

  it('keeps only the last 10 files', () => {
    for (let i = 1; i <= RECENT_LIMIT + 3; i += 1) {
      addRecentFile(`file-${i}.pdf`, i * 1000);
    }
    const list = readRecentFiles();
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]?.name).toBe(`file-${RECENT_LIMIT + 3}.pdf`);
    expect(list.at(-1)?.name).toBe('file-4.pdf');
  });

  it('returns the list as it stands after an add', () => {
    expect(addRecentFile('a.pdf', 1000)).toEqual([{ name: 'a.pdf', openedAt: 1000 }]);
  });

  it('keeps only the last path segment of a name', () => {
    addRecentFile('C:\\Users\\me\\Documents\\tax.pdf', 1000);
    addRecentFile('/home/me/bill.pdf', 2000);
    expect(readRecentFiles().map((entry) => entry.name)).toEqual(['bill.pdf', 'tax.pdf']);
  });
});

describe('recent name cleaning', () => {
  it('drops control characters and empty names', () => {
    expect(cleanRecentName('  re\u0007port.pdf\n ')).toBe('report.pdf');
    expect(cleanRecentName('   ')).toBeNull();
    expect(cleanRecentName(42)).toBeNull();
  });

  it('cuts a long name to the limit', () => {
    expect(cleanRecentName('x'.repeat(400))).toHaveLength(RECENT_NAME_MAX_LENGTH);
  });
});

describe('stored data that is not trusted', () => {
  it('skips malformed entries and sorts what is left', () => {
    window.localStorage.setItem(
      RECENT_STORAGE_KEY,
      JSON.stringify([
        { name: 'old.pdf', openedAt: 1 },
        { name: 5, openedAt: 2 },
        { name: 'no-time.pdf' },
        'text',
        null,
        { name: 'new.pdf', openedAt: 9 },
      ]),
    );
    expect(readRecentFiles()).toEqual([
      { name: 'new.pdf', openedAt: 9 },
      { name: 'old.pdf', openedAt: 1 },
    ]);
  });

  it('reads the empty list for corrupt JSON or a non-array', () => {
    window.localStorage.setItem(RECENT_STORAGE_KEY, '{not json');
    expect(readRecentFiles()).toEqual([]);
    window.localStorage.setItem(RECENT_STORAGE_KEY, '{"name":"a.pdf"}');
    expect(readRecentFiles()).toEqual([]);
  });
});

describe('local storage that throws', () => {
  it('reads the empty list without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRecentFiles()).toEqual([]);
  });

  it('still returns the list for this visit when the write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => addRecentFile('a.pdf', 1000)).not.toThrow();
    expect(addRecentFile('a.pdf', 1000)).toEqual([{ name: 'a.pdf', openedAt: 1000 }]);
    expect(writeRecentFiles([{ name: 'a.pdf', openedAt: 1 }])).toBe(false);
  });
});

describe('secret-like keys are refused', () => {
  it('does not treat the recent-files key as a secret', () => {
    expect(isSecretKey(RECENT_STORAGE_KEY)).toBe(false);
  });

  it('writes nothing under a secret-like key', () => {
    expect(addRecentFile('a.pdf', 1000, 'translation.apiKey')).toEqual([
      { name: 'a.pdf', openedAt: 1000 },
    ]);
    expect(window.localStorage.getItem('translation.apiKey')).toBeNull();
    expect(writeRecentFiles([{ name: 'a.pdf', openedAt: 1 }], 'userPassword')).toBe(false);
    expect(window.localStorage.getItem('userPassword')).toBeNull();
  });
});

describe('no document bytes are stored', () => {
  it('keeps the file name and the time, never the content', () => {
    const secretBytes = 'SECRET-PDF-BYTES-%PDF-1.7-7f3a9c';
    const file = new File([secretBytes], 'contract.pdf', { type: 'application/pdf' });
    addRecentFile(file.name, 1000);
    const everything = Object.keys(window.localStorage)
      .map((key) => `${key}=${window.localStorage.getItem(key) ?? ''}`)
      .join('\n');
    expect(everything).toContain('contract.pdf');
    expect(everything).not.toContain('SECRET-PDF-BYTES');
    expect(everything).not.toContain('%PDF-1.7');
    expect(JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) ?? '[]')).toEqual([
      { name: 'contract.pdf', openedAt: 1000 },
    ]);
  });
});
