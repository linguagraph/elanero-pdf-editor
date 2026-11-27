import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { createRef } from 'react';
import { StatusControls, type StatusControlsProps } from './StatusControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function props(overrides: Partial<StatusControlsProps> = {}): StatusControlsProps {
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

function render(value: StatusControlsProps): void {
  act(() => {
    root.render(<StatusControls {...value} />);
  });
}

// The bar's own buttons and fields, by accessible name (aria-label, else text), in tab order.
function controls(): string[] {
  return [
    ...host.querySelectorAll<HTMLElement>(
      '.doc-status-controls button, .doc-status-controls input',
    ),
  ].map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
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

describe('StatusControls (#808 slice 1)', () => {
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
    expect(host.querySelector('.doc-status-controls')?.getAttribute('aria-label')).toBe(
      t('pill.label'),
    );
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
    const error = host.querySelector('.doc-status-jump .doc-status-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toBe(t('view.jumpInvalid', { input: '99', total: 10 }));
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
    const items = [...host.querySelectorAll('.doc-status-presets button')];
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
    expect(host.querySelector('.doc-status-presets')).toBeNull();
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
    expect(host.querySelector('.doc-status-presets')).toBeNull();
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

describe('StatusControls icons (#796)', () => {
  it('shows an icon, not text, on each button, with its name as the tooltip', () => {
    render(props({ fit: 'page' }));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.doc-status-controls button')];
    expect(buttons).toHaveLength(7);
    for (const el of buttons) {
      expect(el.querySelector('svg.icon')).not.toBeNull();
      expect(el.textContent).toBe('');
      expect(el.getAttribute('title')).toBe(el.getAttribute('aria-label'));
    }
    expect(host.querySelectorAll('.doc-status-group')).toHaveLength(2);
  });
});

describe('StatusControls focus and popups (#808 slice 1)', () => {
  it('hands its page field to the ref, so the host can focus it', () => {
    const ref = createRef<HTMLInputElement>();
    render(props({ pageFieldRef: ref }));
    expect(ref.current).toBe(field(t('view.goToPage')));
  });

  it('opens the preset list, and shows the zoom error in its own element', () => {
    render(props());
    act(() => {
      button(t('pill.zoomPresets')).click();
    });
    expect(host.querySelector('.doc-status-presets')).not.toBeNull();
    act(() => {
      button(t('pill.zoomPresets')).click();
    });
    type(field(t('pill.zoom')), 'abc');
    submit(field(t('pill.zoom')));
    expect(host.querySelector('.doc-status-error')?.getAttribute('role')).toBe('alert');
  });
});
