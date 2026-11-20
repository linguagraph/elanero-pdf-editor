import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { OPEN_COMMAND_PALETTE_EVENT, type PaletteSeed } from '../palette/openCommandPalette';
import { SearchTools } from './SearchTools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let seeds: PaletteSeed[];

function record(event: Event): void {
  seeds.push((event as CustomEvent<PaletteSeed>).detail);
}

beforeEach(() => {
  seeds = [];
  window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, record);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, record);
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function render(iconOnly: boolean): void {
  act(() => {
    root.render(<SearchTools iconOnly={iconOnly} />);
  });
}

function box(): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>('input.ribbon-search');
  if (found === null) throw new Error('the Search tools box is not rendered');
  return found;
}

// React listens for the native 'input' event, so set the value the way a keyboard does.
function type(text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(init: KeyboardEventInit): void {
  act(() => {
    box().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

describe('Search tools box', () => {
  it('is a labelled search box that carries the Search tools name', () => {
    render(false);
    expect(box().type).toBe('search');
    expect(box().getAttribute('aria-label')).toBe(t('ribbon.searchTools'));
    expect(box().placeholder).toBe(t('ribbon.searchTools'));
  });

  it('opens the palette with the first typed character as its query, and clears the box', () => {
    render(false);
    type('r');
    expect(seeds).toEqual([{ query: 'r' }]);
    expect(box().value).toBe('');
  });

  it('opens the palette on Enter with the box text, which is empty once the box has cleared', () => {
    render(false);
    key({ key: 'Enter' });
    expect(seeds).toEqual([{ query: '' }]);
  });

  it('does not open the palette while an IME composition is in progress', () => {
    render(false);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(box(), 'に');
      box().dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    key({ key: 'Enter', isComposing: true });
    expect(seeds).toEqual([]);
    expect(box().value).toBe('に');
  });

  it('renders the icon button when iconOnly, which opens the palette empty', () => {
    render(true);
    expect(host.querySelector('input.ribbon-search')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('button.ribbon-search-button');
    expect(button?.getAttribute('aria-label')).toBe(t('ribbon.searchTools'));
    act(() => {
      button?.click();
    });
    expect(seeds).toEqual([{}]);
  });
});
