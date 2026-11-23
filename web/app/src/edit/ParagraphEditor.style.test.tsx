// The style bar over the paragraph editor (W6.8b slice 1): the keys that change the style, what a
// commit sends, and the focus rules between the text and the bar.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { FontLibraryContext } from '../fonts/fontLibraryContext';
import {
  fakeFontLibrary,
  type FakeFontLibrary,
  fontDto,
  libraryFont,
} from '../fonts/testFontLibrary';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import { ParagraphEditor } from './ParagraphEditor';
import { DEFAULT_TEXT_STYLE, standardRef, toActionStyle } from './textStyle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // The preview font is not under test: the engine has no program for the font.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const paragraph: PageObjectDto = {
  type: 'text',
  key: 'text:3',
  bbox: { x0: 72, y0: 72, x1: 300, y1: 120 },
  text: 'Old words',
  style: { ...DEFAULT_TEXT_STYLE, font: 'Helvetica' },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
};

function mount(
  edited: PageObjectDto = paragraph,
  pageObjects: readonly PageObjectDto[] = [],
  library?: FakeFontLibrary,
) {
  const onApply = vi.fn(async () => true);
  const onClose = vi.fn();
  const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({
    found: false,
    family: 'serif',
    program: null,
  }));
  const rpc = { call } as unknown as PageRpc;
  act(() =>
    root.render(
      <FontLibraryContext.Provider value={library}>
        <ParagraphEditor
          object={edited}
          page={0}
          zoom={1}
          rpc={rpc}
          handle="h1"
          onApply={onApply}
          onClose={onClose}
          pageObjects={pageObjects}
        />
      </FontLibraryContext.Provider>,
    ),
  );
  const area = host.querySelector('textarea') as HTMLTextAreaElement;
  const bar = host.querySelector<HTMLElement>('[role="toolbar"]') as HTMLElement;
  return { area, bar, onApply, onClose, call };
}

// A text block of the page in `font`, for the picker's document section.
function otherBlock(font: string): PageObjectDto {
  return { ...paragraph, key: `text:${font}`, style: { ...DEFAULT_TEXT_STYLE, font } };
}

// Opens the picker and clicks the option shown as `label` (a document font's name, or a standard
// family's translated label).
function pickFont(label: string) {
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  const option = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent === label,
  );
  act(() => option?.click());
}

function keyDown(target: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

function leave(target: HTMLElement, next: EventTarget | null) {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next }));
  });
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('the style bar in the editor', () => {
  it('Ctrl+B toggles bold, and the commit sends the style with the text', async () => {
    const { area, onApply } = mount();
    keyDown(area, { key: 'b', ctrlKey: true });
    const bold = host.querySelector(`button[aria-label="${t('edit.style.bold')}"]`);
    expect(bold?.getAttribute('aria-pressed')).toBe('true');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledWith(
      'Old words',
      toActionStyle({ ...paragraph.style!, bold: true }),
    );
  });

  it('Ctrl+I toggles italic', () => {
    const { area } = mount();
    keyDown(area, { key: 'i', ctrlKey: true });
    const italic = host.querySelector(`button[aria-label="${t('edit.style.italic')}"]`);
    expect(italic?.getAttribute('aria-pressed')).toBe('true');
  });

  it('sends no style when the bar changed nothing, and closes on an unchanged text', async () => {
    const { area, onApply, onClose } = mount();
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in the text cancels the style change with the text', async () => {
    const { area, onApply, onClose } = mount();
    keyDown(area, { key: 'b', ctrlKey: true });
    keyDown(area, { key: 'Escape' });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Alt+F10 moves to the bar, and Escape in the bar returns to the text', () => {
    const { area, bar } = mount();
    keyDown(area, { key: 'F10', altKey: true });
    expect(bar.contains(document.activeElement)).toBe(true);
    keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(document.activeElement).toBe(area);
  });

  it('a focus move from the text into the bar does not commit', async () => {
    const { area, bar, onApply, onClose } = mount();
    const size = bar.querySelector<HTMLElement>('input[type="number"]') as HTMLElement;
    leave(area, size);
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a focus move from the bar to outside commits the text', async () => {
    const { bar, area, onApply } = mount();
    // Give the bar a change, so the leave has something to send.
    keyDown(area, { key: 'b', ctrlKey: true });
    const outside = document.createElement('button');
    document.body.append(outside);
    leave(bar.querySelector<HTMLElement>('[data-stop]') as HTMLElement, outside);
    await flush();
    expect(onApply).toHaveBeenCalledWith(
      'Old words',
      toActionStyle({ ...paragraph.style!, bold: true }),
    );
    outside.remove();
  });

  it('Ctrl+B on a document font with no bold face on the page changes nothing and says why', async () => {
    const calibri: PageObjectDto = {
      ...paragraph,
      style: { ...DEFAULT_TEXT_STYLE, font: 'Calibri' },
    };
    const { area, onApply } = mount(calibri);
    keyDown(area, { key: 'b', ctrlKey: true });
    const bold = host.querySelector(`button[aria-label="${t('edit.style.bold')}"]`);
    expect(bold?.getAttribute('aria-pressed')).toBe('false');
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe(t('edit.style.noBold'));
    // Nothing changed, so the commit sends no style.
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('picking Serif sends the standard font ref with the commit', async () => {
    const { area, onApply } = mount();
    pickFont(t('fonts.picker.serif'));
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledWith(
      'Old words',
      expect.objectContaining({ font: 'Times-Roman', font_ref: standardRef('Times-Roman') }),
    );
  });

  it('picking a document font sends a null font ref with that font', async () => {
    const { area, onApply } = mount(paragraph, [paragraph, otherBlock('Verdana')]);
    pickFont('Verdana');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledWith(
      'Old words',
      expect.objectContaining({ font: 'Verdana', font_ref: null }),
    );
  });

  it('picking a standard font does not preview a document font, and keeps the text upright', () => {
    // Bold and italic on: a document font's own face is shown as is, so the textarea is kept
    // upright (normal weight and style) until the pick makes it a standard font.
    const verdana: PageObjectDto = {
      ...paragraph,
      style: { ...DEFAULT_TEXT_STYLE, font: 'Verdana', bold: true, italic: true },
    };
    const { area, call } = mount(verdana);
    // The opening document font asks the engine for its program once.
    expect(call).toHaveBeenCalledWith('content.preview_font', expect.anything());
    call.mockClear();
    expect(area.style.fontWeight).toBe('normal');
    expect(area.style.fontStyle).toBe('normal');
    pickFont(t('fonts.picker.serif'));
    expect(call.mock.calls.some(([method]) => method === 'content.preview_font')).toBe(false);
    // The standard font takes the bar's bold and italic: the pick keeps both, so the weight and
    // slant now come from the browser, not from the document face's reset.
    expect(area.style.fontWeight).toBe('700');
    expect(area.style.fontStyle).toBe('italic');
  });

  it('a Bold press on a document font with no bold face is announced again on each press', () => {
    const calibri: PageObjectDto = {
      ...paragraph,
      style: { ...DEFAULT_TEXT_STYLE, font: 'Calibri' },
    };
    const { area } = mount(calibri);
    const region = () => host.querySelector('[role="status"]');
    const text = () => region()?.textContent;
    keyDown(area, { key: 'b', ctrlKey: true });
    expect(text()).toBe(t('edit.style.noBold'));
    const firstRegion = region();
    const first = region()?.firstElementChild;
    keyDown(area, { key: 'b', ctrlKey: true });
    expect(text()).toBe(t('edit.style.noBold'));
    // The live region stays the same node; only its child is replaced, so the repeated press is announced.
    expect(region()).toBe(firstRegion);
    expect(region()?.firstElementChild).not.toBe(first);
  });

  describe('with an uploaded family', () => {
    const FAMILY_ID = 'f'.repeat(64);
    const FAMILY_PATH = `/fonts/${FAMILY_ID}.ttf`;
    const face = (weight: number, index: number) => ({
      index,
      family: 'Test Sans',
      style: weight >= 600 ? 'Bold' : 'Regular',
      weight,
      italic: false,
      scripts: ['latin'],
      variable: false,
    });
    const libraryWith = (faces: ReturnType<typeof face>[]) =>
      fakeFontLibrary({
        fonts: [
          libraryFont({
            id: FAMILY_ID,
            name: 'Test.ttf',
            dto: fontDto({ id: FAMILY_ID, path: FAMILY_PATH, faces }),
          }),
        ],
      });
    // The editor opens with no font ref (the block's font is found by name), so the family's FILE
    // ref comes from a pick: the regular face, which Bold then switches.
    it('Ctrl+B switches to the bold face of the family, and the commit sends it', async () => {
      const library = libraryWith([face(400, 0), face(700, 1)]);
      const { area, onApply } = mount(paragraph, [paragraph], library);
      pickFont('Test Sans');
      await flush();
      keyDown(area, { key: 'b', ctrlKey: true });
      const bold = host.querySelector(`button[aria-label="${t('edit.style.bold')}"]`);
      expect(bold?.getAttribute('aria-pressed')).toBe('true');
      keyDown(area, { key: 'Enter', ctrlKey: true });
      await flush();
      expect(onApply).toHaveBeenCalledWith(
        'Old words',
        expect.objectContaining({
          bold: true,
          font_ref: { kind: 'file', name: 'Test Sans', path: FAMILY_PATH, index: 1 },
        }),
      );
    });

    it('Ctrl+B on a family with no bold face changes nothing and says why', async () => {
      const library = libraryWith([face(400, 0)]);
      const { area } = mount(paragraph, [paragraph], library);
      pickFont('Test Sans');
      await flush();
      keyDown(area, { key: 'b', ctrlKey: true });
      const bold = host.querySelector(`button[aria-label="${t('edit.style.bold')}"]`);
      expect(bold?.getAttribute('aria-pressed')).toBe('false');
      expect(host.querySelector('[role="status"]')?.textContent).toBe(t('edit.style.noBold'));
    });

    it('picking the family sends its FILE font ref with the commit, end to end', async () => {
      const library = libraryWith([face(400, 0), face(700, 1)]);
      const { area, onApply } = mount(paragraph, [paragraph], library);
      pickFont('Test Sans');
      await flush();
      keyDown(area, { key: 'Enter', ctrlKey: true });
      await flush();
      expect(onApply).toHaveBeenCalledWith(
        'Old words',
        expect.objectContaining({
          font: 'Test Sans',
          font_ref: { kind: 'file', name: 'Test Sans', path: FAMILY_PATH, index: 0 },
        }),
      );
    });
  });

  it('an arrow key clears the face note', () => {
    const calibri: PageObjectDto = {
      ...paragraph,
      style: { ...DEFAULT_TEXT_STYLE, font: 'Calibri' },
    };
    const { area } = mount(calibri);
    keyDown(area, { key: 'b', ctrlKey: true });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t('edit.style.noBold'));
    keyDown(area, { key: 'ArrowLeft' });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  });
});
