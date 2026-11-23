import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fontDto,
  fakeFontLibrary,
  libraryFont,
  type FakeFontLibrary,
} from '../fonts/testFontLibrary';
import { formatMegabytes } from '../i18n/format';
import { t } from '../i18n/t';
import { FontsSection } from './FontsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MiB = 1024 * 1024;
const SANS_ID = 'a'.repeat(64);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

function render(library: FakeFontLibrary) {
  act(() => {
    root.render(<FontsSection library={library} />);
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (element) => element.textContent === name || element.getAttribute('aria-label') === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

// The confirmation's Remove (the row's own Remove has the same text, so the danger class tells them apart).
function confirmRemove(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('.prefs-danger');
  if (found === null) throw new Error('no confirm button');
  return found;
}

function statusText(): string {
  return host.querySelector('[role="status"]')?.textContent ?? '';
}

function alertText(): string {
  return host.querySelector('[role="alert"]')?.textContent ?? '';
}

// Picks files in the hidden input and fires its change, as the file dialog does.
async function pick(files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  // Several adds run one after another; let each settle.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function sansFont() {
  return libraryFont({
    id: SANS_ID,
    name: 'TestSans-Regular.ttf',
    size: 2 * MiB,
    dto: fontDto({ id: SANS_ID, name: 'TestSans-Regular.ttf' }),
  });
}

describe('FontsSection', () => {
  it('shows the empty list and no Remove all when nothing is uploaded', () => {
    render(fakeFontLibrary());
    expect(host.textContent).toContain(t('fonts.list.empty'));
    expect(button(t('fonts.removeAll')).disabled).toBe(true);
  });

  it('lists each font with its faces, file and size, and the usage', () => {
    render(
      fakeFontLibrary({
        fonts: [sansFont(), libraryFont({ id: 'b'.repeat(64), name: 'Later.otf', loaded: false })],
        usedBytes: 2 * MiB,
        maxBytes: 256 * MiB,
      }),
    );
    const rows = host.querySelectorAll('[role="list"] > li');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Test Sans');
    expect(rows[0]?.textContent).toContain('TestSans-Regular.ttf');
    expect(rows[0]?.textContent).toContain(formatMegabytes(2 * MiB));
    expect(rows[1]?.textContent).toContain('Later.otf');
    expect(rows[1]?.textContent).toContain(t('fonts.row.notLoaded'));
    expect(host.textContent).toContain(
      t('fonts.usage', { used: formatMegabytes(2 * MiB), max: formatMegabytes(256 * MiB) }),
    );
  });

  it('says the fonts last only for this tab when the browser cannot keep them', () => {
    render(fakeFontLibrary({ storage: 'session' }));
    expect(host.textContent).toContain(t('fonts.storage.sessionOnly'));
  });

  it('shows the loading text while the start-up sync runs', () => {
    render(fakeFontLibrary({ syncing: true, busy: true, fonts: [sansFont()] }));
    expect(host.textContent).toContain(t('fonts.loading'));
    expect(host.querySelector('[role="list"]')).toBeNull();
  });

  it('turns the buttons off while a font operation runs', () => {
    render(fakeFontLibrary({ busy: true, fonts: [sansFont()] }));
    expect(button(t('fonts.upload.button')).disabled).toBe(true);
    expect(button(t('fonts.removeAll')).disabled).toBe(true);
    expect(button(t('fonts.remove.label', { name: 'TestSans-Regular.ttf' })).disabled).toBe(true);
  });

  it('gives one outcome line per picked file, in order', async () => {
    const library = fakeFontLibrary();
    library.add
      .mockResolvedValueOnce({ kind: 'added', font: sansFont() })
      .mockResolvedValueOnce({
        kind: 'refused',
        code: 'FONT_NOT_EMBEDDABLE',
        details: { reason: 'restricted' },
      })
      .mockResolvedValueOnce({
        kind: 'refused',
        code: 'INVALID_FONT',
        details: { reason: 'not_a_font' },
      });
    render(library);
    const files = [
      new File(['a'], 'TestSans-Regular.ttf'),
      new File(['b'], 'TestRestricted-Regular.ttf'),
      new File(['c'], 'Garbage.ttf'),
    ];
    await pick(files);
    expect(library.add.mock.calls.map((call) => call[0].name)).toEqual([
      'TestSans-Regular.ttf',
      'TestRestricted-Regular.ttf',
      'Garbage.ttf',
    ]);
    expect(statusText()).toContain('TestSans-Regular.ttf was added.');
    expect(alertText()).toContain(
      "TestRestricted-Regular.ttf can't be added: its licence does not allow embedding it in documents.",
    );
    expect(alertText()).toContain('Garbage.ttf is not a font file that can be read.');
  });

  it('clears the outcome lines at the next upload', async () => {
    const library = fakeFontLibrary();
    library.add.mockResolvedValueOnce({ kind: 'added', font: sansFont() });
    render(library);
    await pick([new File(['a'], 'TestSans-Regular.ttf')]);
    expect(statusText()).toContain('was added.');
    library.add.mockResolvedValueOnce({ kind: 'tooLarge' });
    await pick([new File(['b'], 'Big.ttf')]);
    expect(statusText()).toBe('');
    expect(alertText()).toContain('Big.ttf is larger than');
  });

  it('Remove asks first, Keep takes focus and removes nothing', () => {
    const library = fakeFontLibrary({ fonts: [sansFont()] });
    render(library);
    act(() => {
      button(t('fonts.remove.label', { name: 'TestSans-Regular.ttf' })).click();
    });
    const keep = button(t('fonts.confirm.keep'));
    expect(document.activeElement).toBe(keep);
    act(() => {
      keep.click();
    });
    expect(library.remove).not.toHaveBeenCalled();
    expect(host.querySelector('[role="group"]')).toBeNull();
  });

  it('Remove after the confirmation removes the font and says so', async () => {
    const library = fakeFontLibrary({ fonts: [sansFont()] });
    render(library);
    act(() => {
      button(t('fonts.remove.label', { name: 'TestSans-Regular.ttf' })).click();
    });
    await act(async () => {
      confirmRemove().click();
      await Promise.resolve();
    });
    expect(library.remove).toHaveBeenCalledWith(SANS_ID);
    expect(statusText()).toContain(t('fonts.removed', { name: 'TestSans-Regular.ttf' }));
  });

  it('Remove all asks first and then removes every font', async () => {
    const library = fakeFontLibrary({ fonts: [sansFont()] });
    render(library);
    act(() => {
      button(t('fonts.removeAll')).click();
    });
    expect(document.activeElement).toBe(button(t('fonts.confirm.keep')));
    await act(async () => {
      confirmRemove().click();
      await Promise.resolve();
    });
    expect(library.removeAll).toHaveBeenCalledOnce();
    expect(statusText()).toContain(t('fonts.removedAll'));
  });

  it('a removal that the browser refused is an alert', async () => {
    const library = fakeFontLibrary({ fonts: [sansFont()] });
    library.remove.mockResolvedValueOnce({ kind: 'notRemoved' });
    render(library);
    act(() => {
      button(t('fonts.remove.label', { name: 'TestSans-Regular.ttf' })).click();
    });
    await act(async () => {
      confirmRemove().click();
      await Promise.resolve();
    });
    expect(alertText()).toContain(t('fonts.remove.failed', { name: 'TestSans-Regular.ttf' }));
  });
});
