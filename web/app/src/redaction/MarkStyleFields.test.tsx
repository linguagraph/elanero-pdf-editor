import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { colorInputValue, MarkStyleFields } from './MarkStyleFields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const value = { fill: { r: 1, g: 0, b: 0 }, textColor: null, overlayText: 'EXEMPT' };

function render(props: Partial<Parameters<typeof MarkStyleFields>[0]> = {}) {
  const onChange = vi.fn();
  act(() => {
    root.render(<MarkStyleFields value={value} onChange={onChange} {...props} />);
  });
  return onChange;
}

describe('colorInputValue', () => {
  it('gives the colour input its #rrggbb value, and black for no colour', () => {
    expect(colorInputValue({ r: 1, g: 0.5, b: 0 })).toBe('#ff8000');
    expect(colorInputValue(null)).toBe('#000000');
  });
});

describe('MarkStyleFields', () => {
  it('shows the fill, text colour and overlay text of the value', () => {
    render();
    const colours = container.querySelectorAll<HTMLInputElement>('input[type="color"]');
    expect(colours[0]?.value).toBe('#ff0000');
    expect(colours[1]?.value).toBe('#000000');
    expect(container.querySelector<HTMLInputElement>('.mark-style-overlay')?.value).toBe('EXEMPT');
  });

  it('marks a mixed field and leaves the overlay text empty for a mixed selection', () => {
    render({ mixed: { fill: true, overlayText: true }, value: { ...value, overlayText: '' } });
    expect(container.textContent).toContain(t('redactions.mixed'));
    expect(container.querySelector<HTMLInputElement>('.mark-style-overlay')?.placeholder).toBe(
      t('redactions.mixed'),
    );
  });

  it('disables every field when disabled', () => {
    render({ disabled: true });
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    expect(Array.from(inputs).every((input) => input.disabled)).toBe(true);
  });

  it('caps the overlay text at the engine limit', () => {
    render();
    expect(container.querySelector<HTMLInputElement>('.mark-style-overlay')?.maxLength).toBe(500);
  });
});
