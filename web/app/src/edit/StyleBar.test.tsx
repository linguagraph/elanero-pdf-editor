import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import type { TextStyleDto } from '../rpc/generated';
import { StyleBar, type StyleBarProps } from './StyleBar';
import { DEFAULT_TEXT_STYLE } from './textStyle';

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

const style: TextStyleDto = {
  ...DEFAULT_TEXT_STYLE,
  font: 'ABCDEF+Arial',
  size: 12,
  color: { r: 0, g: 0, b: 0, a: 1 },
};

function mount(overrides: Partial<StyleBarProps> = {}) {
  const props = {
    rootRef: createRef<HTMLDivElement>(),
    style: {},
    value: style,
    font: 'ABCDEF+Arial',
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
    expect(host.textContent).toContain('ABCDEF+Arial');
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('12');
    expect(button(t('edit.style.bold')).getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe('#000000');
  });

  it('gives one control the tab stop at a time', () => {
    mount();
    expect(stops().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
  });

  it('toggles bold and italic through onChange, with the rest of the style kept', () => {
    const { onChange } = mount();
    button(t('edit.style.bold')).click();
    expect(onChange).toHaveBeenLastCalledWith({ ...style, bold: true });
    button(t('edit.style.italic')).click();
    expect(onChange).toHaveBeenLastCalledWith({ ...style, italic: true });
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
});
