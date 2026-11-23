import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fontDto, libraryFont } from '../fonts/testFontLibrary';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import { fontSections } from './fontList';
import { StyleBar, type StyleBarProps } from './StyleBar';
import { DEFAULT_TEXT_ARG, type FontRefArg, standardRef, type TextStyleArg } from './textStyle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const style: TextStyleArg = {
  ...DEFAULT_TEXT_ARG,
  font: 'ABCDEF+Arial',
  size: 12,
  color: { r: 0, g: 0, b: 0, a: 1 },
};

// A standard font has every face, so Bold and Italic can always change the text.
const standard: TextStyleArg = { ...style, font: 'Helvetica', font_ref: standardRef('Helvetica') };

function mount(overrides: Partial<StyleBarProps> = {}) {
  const props = {
    rootRef: createRef<HTMLDivElement>(),
    style: {},
    value: style,
    fonts: fontSections([], 'ABCDEF+Arial'),
    onChange: vi.fn(),
    onCommit: vi.fn(),
    onEscape: vi.fn(),
    onLeave: vi.fn(),
    ...overrides,
  } satisfies StyleBarProps;
  act(() => root.render(<StyleBar {...props} />));
  const bar = host.querySelector<HTMLDivElement>('[role="toolbar"]') as HTMLDivElement;
  return { ...props, bar };
}

// A text block of the page with `font` (only the fields the picker reads).
function textBlock(font: string): PageObjectDto {
  return {
    type: 'text',
    key: font,
    bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
    text: 'x',
    style: { ...style, font },
    editable: true,
    reason: '',
    image_size: [0, 0],
    stroke: false,
    fill: false,
  };
}

const stops = () => Array.from(host.querySelectorAll<HTMLElement>('[data-stop]'));
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) as HTMLButtonElement;

function keyDown(target: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

// React's onBlur listens to focusout, which bubbles; a blur to `next` is sent that way.
function leave(target: HTMLElement, next: EventTarget | null) {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next }));
  });
}

// Sets a field's value the way the browser does (the native setter, so React sees the change), then
// sends the event the field reports it with.
function setField(
  field: HTMLInputElement | HTMLSelectElement,
  value: string,
  event: 'input' | 'change',
) {
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

function typeNumber(input: HTMLInputElement, text: string) {
  setField(input, text, 'input');
}

describe('the style bar', () => {
  it('is a toolbar named Text style, showing the font and the values', () => {
    const { bar } = mount();
    expect(bar.getAttribute('aria-label')).toBe(t('edit.style.toolbar'));
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toContain('Arial');
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('12');
    expect(button(t('edit.style.bold')).getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe('#000000');
  });

  it('gives one control the tab stop at a time', () => {
    mount();
    expect(stops().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
  });

  it('toggles bold and italic through onChange, with the rest of the style kept', () => {
    const { onChange } = mount({ value: standard });
    button(t('edit.style.bold')).click();
    expect(onChange).toHaveBeenLastCalledWith({ ...standard, bold: true });
    button(t('edit.style.italic')).click();
    expect(onChange).toHaveBeenLastCalledWith({ ...standard, italic: true });
  });

  it('moves focus between the controls with the arrow keys, not from a text field', () => {
    mount();
    button(t('edit.style.bold')).focus();
    keyDown(button(t('edit.style.bold')), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(button(t('edit.style.italic')));
    expect(button(t('edit.style.italic')).tabIndex).toBe(0);
    keyDown(button(t('edit.style.italic')), { key: 'End' });
    expect(document.activeElement).toBe(stops().at(-1));
    // In a text field the arrows keep their meaning (the caret): the focus does not leave it.
    const size = host.querySelector<HTMLInputElement>('input[type="number"]') as HTMLInputElement;
    act(() => size.focus());
    keyDown(size, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(size);
  });

  it('clamps the size to its range when the field is left, not while typing', () => {
    const { onChange } = mount();
    const size = host.querySelector<HTMLInputElement>('input[type="number"]') as HTMLInputElement;
    typeNumber(size, '200');
    expect(onChange).not.toHaveBeenCalled();
    leave(size, null);
    expect(onChange).toHaveBeenLastCalledWith({ ...style, size: 144 });
  });

  it('keeps the value and sends nothing for an empty size', () => {
    const { onChange } = mount();
    const size = host.querySelector<HTMLInputElement>('input[type="number"]') as HTMLInputElement;
    typeNumber(size, '');
    leave(size, null);
    expect(onChange).not.toHaveBeenCalled();
    expect(size.value).toBe('12');
  });

  it('sets the colour, keeping the alpha, and the alignment', () => {
    const { onChange } = mount();
    const colour = host.querySelector<HTMLInputElement>('input[type="color"]') as HTMLInputElement;
    setField(colour, '#ff0000', 'input');
    expect(onChange).toHaveBeenLastCalledWith({
      ...style,
      color: { r: 1, g: 0, b: 0, a: 1 },
    });
    const align = host.querySelector<HTMLSelectElement>('select') as HTMLSelectElement;
    setField(align, 'center', 'change');
    expect(onChange).toHaveBeenLastCalledWith({ ...style, align: 'center' });
  });

  it('commits on Ctrl+Enter and goes back to the text on Escape, from any control', () => {
    const { onCommit, onEscape } = mount();
    keyDown(button(t('edit.style.bold')), { key: 'Enter', ctrlKey: true });
    expect(onCommit).toHaveBeenCalledTimes(1);
    keyDown(button(t('edit.style.bold')), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('reports a focus leave to an outside element, but not a move inside the bar', () => {
    const { onLeave } = mount();
    const outside = document.createElement('button');
    document.body.append(outside);
    leave(button(t('edit.style.bold')), button(t('edit.style.italic')));
    expect(onLeave).not.toHaveBeenCalled();
    leave(button(t('edit.style.bold')), outside);
    expect(onLeave).toHaveBeenCalledWith(outside);
    outside.remove();
  });

  it('stays open while the native colour dialog takes the window focus', () => {
    const { onLeave } = mount();
    const colour = host.querySelector<HTMLInputElement>('input[type="color"]') as HTMLInputElement;
    act(() => colour.click());
    leave(colour, null);
    expect(onLeave).not.toHaveBeenCalled();
    // Once focus goes to a real element, the leave counts again.
    const outside = document.createElement('button');
    document.body.append(outside);
    leave(colour, outside);
    expect(onLeave).toHaveBeenCalledWith(outside);
    outside.remove();
  });

  it('disables Bold for a document font with no bold face on the page, with the reason', () => {
    const { onChange } = mount({ value: style });
    const bold = button(t('edit.style.bold'));
    expect(bold.getAttribute('aria-disabled')).toBe('true');
    expect(bold.title).toBe(t('edit.style.noBold'));
    bold.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('switches a document font to its bold face on the page', () => {
    const page = ['ABCDEF+Arial', 'ABCDEF+Arial-BoldMT'];
    const { onChange } = mount({
      value: style,
      fonts: fontSections(
        page.map((font) => textBlock(font)),
        'ABCDEF+Arial',
      ),
    });
    button(t('edit.style.bold')).click();
    expect(onChange).toHaveBeenLastCalledWith({
      ...style,
      font: 'ABCDEF+Arial-BoldMT',
      bold: true,
    });
  });

  it('picks a standard font through the picker, with its ref', () => {
    const { onChange } = mount({ value: style });
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const serif = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (o) => o.textContent === t('fonts.picker.serif'),
    );
    act(() => serif?.click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...style,
      font: 'Times-Roman',
      font_ref: standardRef('Times-Roman'),
    });
  });
});

// An uploaded family with a regular and a bold face (none italic), for Bold and Italic.
const FAMILY_ID = 'e'.repeat(64);
const FAMILY_PATH = `/fonts/${FAMILY_ID}.ttf`;
const familyFace = (weight: number, index: number) => ({
  index,
  family: 'Test Sans',
  style: weight >= 600 ? 'Bold' : 'Regular',
  weight,
  italic: false,
  scripts: ['latin'],
  variable: false,
});
const uploadedSections = fontSections([], 'ABCDEF+Arial', [
  libraryFont({
    id: FAMILY_ID,
    name: 'Test.ttf',
    dto: fontDto({
      id: FAMILY_ID,
      path: FAMILY_PATH,
      faces: [familyFace(400, 0), familyFace(700, 1)],
    }),
  }),
]);
const familyStyle = (over: Partial<TextStyleArg> = {}): TextStyleArg => ({
  ...style,
  font: 'Test Sans',
  font_ref: { kind: 'file', name: 'Test Sans', path: FAMILY_PATH, index: 0 } as FontRefArg,
  ...over,
});
const fileRef = (index: number) =>
  ({ kind: 'file', name: 'Test Sans', path: FAMILY_PATH, index }) as FontRefArg;

// Opens the picker and picks its upload row; returns the combobox the focus is in.
function openUploadRow() {
  const combo = host.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
  keyDown(combo, { key: 'ArrowDown' });
  const upload = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent === t('fonts.upload.button'),
  );
  act(() => upload?.click());
  return combo;
}

describe('the style bar with uploaded faces', () => {
  it('Bold switches an uploaded family to its bold face, and back to the regular one', () => {
    const { onChange } = mount({ value: familyStyle(), fonts: uploadedSections });
    expect(button(t('edit.style.bold')).getAttribute('aria-disabled')).toBe('false');
    button(t('edit.style.bold')).click();
    expect(onChange).toHaveBeenLastCalledWith({
      ...familyStyle(),
      bold: true,
      font_ref: fileRef(1),
    });
    const back = mount({
      value: familyStyle({ bold: true, font_ref: fileRef(1) }),
      fonts: uploadedSections,
    });
    button(t('edit.style.bold')).click();
    expect(back.onChange).toHaveBeenLastCalledWith({
      ...familyStyle({ bold: true, font_ref: fileRef(1) }),
      bold: false,
      font_ref: fileRef(0),
    });
  });

  it('Italic is disabled with its reason when the family has no italic face', () => {
    const { onChange } = mount({ value: familyStyle(), fonts: uploadedSections });
    const italic = button(t('edit.style.italic'));
    expect(italic.getAttribute('aria-disabled')).toBe('true');
    expect(italic.title).toBe(t('edit.style.noItalic'));
    italic.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picking a family takes the face of the current bold', () => {
    const { onChange } = mount({ value: { ...style, bold: true }, fonts: uploadedSections });
    const combo = host.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
    keyDown(combo, { key: 'ArrowDown' });
    const family = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (o) => o.textContent === 'Test Sans',
    );
    act(() => family?.click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...style,
      bold: true,
      font: 'Test Sans',
      font_ref: fileRef(1),
    });
  });

  it('the upload row sets picking, so a blur to nothing is not a leave until the file change', () => {
    const upload = { setInput: vi.fn(), onOpen: vi.fn(), onChange: vi.fn() };
    const { onLeave } = mount({ value: style, fonts: uploadedSections, upload });
    const combo = openUploadRow();
    expect(upload.onOpen).toHaveBeenCalledTimes(1);
    leave(combo, null);
    expect(onLeave).not.toHaveBeenCalled();
    const file = host.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
    act(() => {
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(upload.onChange).toHaveBeenCalledTimes(1);
    leave(combo, null);
    expect(onLeave).toHaveBeenCalledWith(null);
  });

  it('a cancelled file dialog clears picking, so the next blur to nothing is a leave', () => {
    const upload = { setInput: vi.fn(), onOpen: vi.fn(), onChange: vi.fn() };
    const { onLeave } = mount({ value: style, fonts: uploadedSections, upload });
    const combo = openUploadRow();
    const file = host.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
    act(() => {
      file.dispatchEvent(new Event('cancel'));
    });
    expect(upload.onChange).not.toHaveBeenCalled();
    leave(combo, null);
    expect(onLeave).toHaveBeenCalledWith(null);
  });
});
