import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { currentShapeStyle, DEFAULT_SHAPE_STYLE, setShapeStyle } from './shapeStyle';
import { ShapeStyleDialog } from './ShapeStyleDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

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
  document.body.innerHTML = '';
  setShapeStyle(DEFAULT_SHAPE_STYLE);
  vi.restoreAllMocks();
});

function open(onClose = vi.fn()) {
  act(() => {
    root.render(<ShapeStyleDialog isOpen onClose={onClose} />);
  });
  return onClose;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(found).not.toBeNull();
  return found as HTMLElement;
}

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

function field(selector: string): HTMLInputElement {
  const found = dialog().querySelector<HTMLInputElement>(selector);
  expect(found).not.toBeNull();
  return found as HTMLInputElement;
}

const fillBox = () => field('input[type="checkbox"]');
const fillColour = () => field('input[type="color"][aria-label]');
const widthField = () => field('input[type="number"]');

// React listens for the value through the element's own setter, so it is set from the prototype.
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the Shape Style dialog', () => {
  it('starts from the style in use, with the fill colour off until Fill is ticked', () => {
    open();
    expect(fillBox().checked).toBe(false);
    expect(fillColour().disabled).toBe(true);
    expect(widthField().value).toBe('1.5');
  });

  it('stores the style on OK, with the fill when Fill is ticked, and closes', () => {
    const onClose = open();
    type(widthField(), '6');
    act(() => {
      fillBox().click();
    });
    expect(fillColour().disabled).toBe(false);
    act(() => {
      button(t('edit.shapeStyle.ok')).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(currentShapeStyle()).toEqual({
      outline: { r: 0, g: 0, b: 0 },
      fill: { r: 1, g: 1, b: 1 },
      width: 6,
    });
  });

  it('keeps an invalid width out: OK is disabled and the error is shown', () => {
    open();
    type(widthField(), '100');
    expect(widthField().getAttribute('aria-invalid')).toBe('true');
    expect(button(t('edit.shapeStyle.ok')).disabled).toBe(true);
    expect(dialog().textContent).toContain(t('edit.shapeStyle.widthInvalid'));
  });

  it('leaves the style alone on Cancel', () => {
    const onClose = open();
    type(widthField(), '9');
    act(() => {
      button(t('edit.shapeStyle.cancel')).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(currentShapeStyle()).toEqual(DEFAULT_SHAPE_STYLE);
  });
});
