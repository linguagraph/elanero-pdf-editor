// The font picker (W6.8b slice 2, design section 4.4): the sections, the keys, and the ARIA roles.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import { FontPicker, type StopProps } from './FontPicker';
import { fontSections, selectedOption } from './fontList';
import { DEFAULT_TEXT_ARG } from './textStyle';

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

const page = (font: string): PageObjectDto => ({
  type: 'text',
  key: font,
  bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
  text: 'x',
  style: { ...DEFAULT_TEXT_ARG, font },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
});

const stop: StopProps = { 'data-stop': true, tabIndex: 0, onFocus: () => undefined };

function mount(blockFont = 'ABCDEF+Arial', onPick = vi.fn()) {
  const sections = fontSections([page(blockFont), page('Calibri')], blockFont);
  const selected = selectedOption(sections, { ...DEFAULT_TEXT_ARG, font: blockFont });
  act(() =>
    root.render(<FontPicker sections={sections} selected={selected} stop={stop} onPick={onPick} />),
  );
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
  return { input, onPick };
}

function keyDown(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const options = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
const headings = () => Array.from(host.querySelectorAll<HTMLElement>('.edit-font-heading'));

describe('the font picker', () => {
  it('is a combobox showing the selected font, with the popup closed', () => {
    const { input } = mount();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe(t('fonts.picker.subset', { name: 'Arial' }));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('opens with the arrow key, and lists the document section before the standard one', () => {
    const { input } = mount();
    keyDown(input, 'ArrowDown');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const groups = Array.from(host.querySelectorAll('[role="group"]'));
    expect(groups.map((g) => g.querySelector('.edit-font-heading')?.textContent)).toEqual([
      t('fonts.picker.document'),
      t('fonts.picker.standard'),
    ]);
    // The headings are labels of the groups, never options.
    expect(headings()).toHaveLength(2);
    expect(options().map((o) => o.textContent)).toEqual([
      t('fonts.picker.subset', { name: 'Arial' }),
      'Calibri',
      t('fonts.picker.sans'),
      t('fonts.picker.serif'),
      t('fonts.picker.mono'),
    ]);
  });

  it('moves the highlight with the arrows, skipping the headings, and Enter picks it', () => {
    const { input, onPick } = mount();
    keyDown(input, 'ArrowDown');
    keyDown(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
    keyDown(input, 'Enter');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'Calibri' }));
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('filters by what is typed, and says so when nothing matches', () => {
    const { input } = mount();
    type(input, 'serif');
    expect(options().map((o) => o.textContent)).toEqual([t('fonts.picker.serif')]);
    type(input, 'zzz');
    expect(options()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t('fonts.picker.noMatch'));
  });

  it('a click on an option picks it', () => {
    const { input, onPick } = mount();
    keyDown(input, 'ArrowDown');
    options()[3]?.click();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'Times-Roman' }));
  });

  it('Escape closes the popup and stops there, so the bar keeps its state', () => {
    const { input } = mount();
    keyDown(input, 'ArrowDown');
    // A listener above the picker sees the keys the picker lets go on.
    const above = vi.fn();
    document.body.addEventListener('keydown', above);
    keyDown(input, 'Escape');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(above).not.toHaveBeenCalled();
    // With the popup closed, Escape is the bar's again.
    keyDown(input, 'Escape');
    expect(above).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('keydown', above);
  });

  it('has no Uploaded section before the uploads of 8b-3', () => {
    const { input } = mount();
    keyDown(input, 'ArrowDown');
    expect(host.textContent).not.toContain('Uploaded');
  });
});
