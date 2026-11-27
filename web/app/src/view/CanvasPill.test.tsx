import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { CanvasPill, type CanvasPillProps, FADE_AFTER_MS } from './CanvasPill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function props(overrides: Partial<CanvasPillProps> = {}): CanvasPillProps {
  return {
    page: 1,
    total: 10,
    labels: [],
    zoom: 1,
    fit: null,
    onGoTo: vi.fn(),
    onStep: vi.fn(),
    onZoom: vi.fn(),
    onZoomStep: vi.fn(),
    ...overrides,
  };
}

function render(value: CanvasPillProps): void {
  act(() => {
    root.render(<CanvasPill {...value} />);
  });
}

// The pill's own buttons and fields, by accessible name (aria-label, else text), in tab order.
function controls(): string[] {
  return [...host.querySelectorAll<HTMLElement>('.canvas-pill button, .canvas-pill input')].map(
    (el) => el.getAttribute('aria-label') ?? el.textContent ?? '',
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

function field(label: string): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`no field ${label}`);
  return found;
}

// Types into a field the way a user does: the native setter, then an input event for React.
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Submits the form a field is in, as Enter does.
function submit(input: HTMLInputElement): void {
  act(() => {
    input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CanvasPill controls (W4.2a S5)', () => {
  it('lists the navigator, then the zoom, then the fits, in the desktop order', () => {
    render(props());
    expect(controls()).toEqual([
      t('pill.previousPage'),
      t('view.goToPage'),
      t('pill.nextPage'),
      t('view.zoomOut'),
      t('pill.zoom'),
      t('pill.zoomPresets'),
      t('view.zoomIn'),
      t('view.fitWidth'),
      t('view.fitPage'),
    ]);
    expect(host.querySelector('.canvas-pill')?.getAttribute('aria-label')).toBe(t('pill.label'));
  });

  it('shows the zoom as a percentage and the page as the field and the total', () => {
    render(props({ page: 3, zoom: 1.5 }));
    expect(field(t('pill.zoom')).value).toBe('150%');
    expect(field(t('view.goToPage')).value).toBe('3');
    expect(host.textContent).toContain(t('pill.pageCount', { total: 10 }));
  });

  it('disables previous on the first page and next on the last', () => {
    render(props({ page: 1 }));
    expect(button(t('pill.previousPage')).disabled).toBe(true);
    expect(button(t('pill.nextPage')).disabled).toBe(false);
    render(props({ page: 10 }));
    expect(button(t('pill.nextPage')).disabled).toBe(true);
  });

  it('steps the page with previous and next', () => {
    const onStep = vi.fn();
    render(props({ page: 4, onStep }));
    act(() => {
      button(t('pill.previousPage')).click();
    });
    act(() => {
      button(t('pill.nextPage')).click();
    });
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
  });

  it('jumps to a typed page on submit, and reports a bad one', () => {
    const onGoTo = vi.fn();
    render(props({ onGoTo }));
    const jump = field(t('view.goToPage'));
    type(jump, '3');
    submit(jump);
    expect(onGoTo).toHaveBeenCalledWith(2);

    type(jump, '99');
    submit(jump);
    expect(onGoTo).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      t('view.jumpInvalid', { input: '99', total: 10 }),
    );
  });

  it('applies a typed zoom on submit, and reports one that is not a zoom', () => {
    const onZoom = vi.fn();
    render(props({ onZoom }));
    const zoom = field(t('pill.zoom'));
    type(zoom, '150%');
    submit(zoom);
    expect(onZoom).toHaveBeenCalledWith({ zoom: 1.5 });

    type(zoom, 'abc');
    submit(zoom);
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      t('pill.zoomInvalid', { input: 'abc' }),
    );
  });

  it('lists the presets and applies the one picked, then closes the list', () => {
    const onZoom = vi.fn();
    render(props({ onZoom }));
    act(() => {
      button(t('pill.zoomPresets')).click();
    });
    expect(button(t('pill.zoomPresets')).getAttribute('aria-expanded')).toBe('true');
    const items = [...host.querySelectorAll('.canvas-pill-presets button')];
    expect(items.map((item) => item.textContent)).toEqual([
      t('view.fitWidth'),
      t('view.fitPage'),
      '50%',
      '75%',
      '100%',
      '125%',
      '150%',
      '200%',
      '400%',
    ]);
    act(() => {
      items[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onZoom).toHaveBeenCalledWith({ zoom: 0.5 });
    expect(host.querySelector('.canvas-pill-presets')).toBeNull();
  });

  it('closes the preset list on Escape', () => {
    render(props());
    act(() => {
      button(t('pill.zoomPresets')).click();
    });
    const zoom = field(t('pill.zoom'));
    act(() => {
      zoom.form?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('.canvas-pill-presets')).toBeNull();
  });

  it('asks for a fit mode from the fit buttons and shows the one in effect', () => {
    const onZoom = vi.fn();
    render(props({ fit: 'page', onZoom }));
    expect(button(t('view.fitPage')).getAttribute('aria-pressed')).toBe('true');
    expect(button(t('view.fitWidth')).getAttribute('aria-pressed')).toBe('false');
    act(() => {
      button(t('view.fitWidth')).click();
    });
    expect(onZoom).toHaveBeenCalledWith({ fit: 'width' });
  });

  it('steps the zoom with minus and plus, and stops at the limits', () => {
    const onZoomStep = vi.fn();
    render(props({ zoom: 1, onZoomStep }));
    act(() => {
      button(t('view.zoomIn')).click();
      button(t('view.zoomOut')).click();
    });
    expect(onZoomStep.mock.calls).toEqual([[1], [-1]]);

    render(props({ zoom: 64 }));
    expect(button(t('view.zoomIn')).disabled).toBe(true);
    render(props({ zoom: 0.05 }));
    expect(button(t('view.zoomOut')).disabled).toBe(true);
  });
});

describe('CanvasPill fade (W4.2a S5)', () => {
  const shown = () => host.querySelector('.canvas-pill')?.getAttribute('data-shown');

  it('fades after 3 s without pointer, scroll or focus, and comes back on a pointer move', () => {
    vi.useFakeTimers();
    render(props());
    expect(shown()).toBe('true');
    act(() => {
      vi.advanceTimersByTime(FADE_AFTER_MS - 1);
    });
    expect(shown()).toBe('true');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe('false');

    act(() => {
      host.dispatchEvent(new Event('pointermove', { bubbles: true }));
    });
    expect(shown()).toBe('true');
  });

  it('shows again when the page area scrolls', () => {
    vi.useFakeTimers();
    render(props());
    act(() => {
      vi.advanceTimersByTime(FADE_AFTER_MS);
    });
    expect(shown()).toBe('false');
    act(() => {
      host.querySelector('.canvas-pill')?.parentElement?.dispatchEvent(new Event('scroll'));
    });
    expect(shown()).toBe('true');
  });

  it('stays shown while focus is in it, and fades after focus leaves', () => {
    vi.useFakeTimers();
    render(props());
    act(() => {
      field(t('pill.zoom')).focus();
    });
    act(() => {
      vi.advanceTimersByTime(FADE_AFTER_MS * 2);
    });
    expect(shown()).toBe('true');
    act(() => {
      field(t('pill.zoom')).blur();
    });
    act(() => {
      vi.advanceTimersByTime(FADE_AFTER_MS);
    });
    expect(shown()).toBe('false');
  });

  it('stays shown while the preset list is open', () => {
    vi.useFakeTimers();
    render(props());
    act(() => {
      button(t('pill.zoomPresets')).click();
    });
    act(() => {
      vi.advanceTimersByTime(FADE_AFTER_MS * 2);
    });
    expect(shown()).toBe('true');
  });
});

describe('CanvasPill width (W4.2a S5)', () => {
  it('is hidden when the page area is narrower than the pill', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 300 });
    render(props());
    expect(host.querySelector('.canvas-pill')?.hasAttribute('hidden')).toBe(true);
  });

  it('is shown when the page area is wide enough', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(500);
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 900 });
    render(props());
    expect(host.querySelector('.canvas-pill')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('CanvasPill icons (#796)', () => {
  it('shows an icon, not text, on each button, with its name as the tooltip', () => {
    render(props({ fit: 'page' }));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.canvas-pill button')];
    expect(buttons).toHaveLength(7);
    for (const el of buttons) {
      expect(el.querySelector('svg.icon')).not.toBeNull();
      expect(el.textContent).toBe('');
      expect(el.getAttribute('title')).toBe(el.getAttribute('aria-label'));
    }
    expect(host.querySelectorAll('.canvas-pill-group')).toHaveLength(2);
  });
});
