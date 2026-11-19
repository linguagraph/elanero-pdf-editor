import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { DocumentStatusBar, type DocumentStatusBarProps } from './DocumentStatusBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function props(overrides: Partial<DocumentStatusBarProps> = {}): DocumentStatusBarProps {
  return {
    page: 1,
    total: 10,
    zoom: 1,
    layout: 'continuous',
    canBack: false,
    canForward: false,
    onGoTo: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    ...overrides,
  };
}

function render(value: DocumentStatusBarProps): void {
  act(() => {
    root.render(<DocumentStatusBar {...value} />);
  });
}

function field(): HTMLInputElement {
  const found = host.querySelector('input');
  if (found === null) throw new Error('no page field');
  return found;
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

// Types into the field (through the native setter, so React sees the change) and submits the form,
// as the reader does with Enter.
function typeAndSubmit(text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    field().form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
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
  vi.restoreAllMocks();
});

describe('page jump', () => {
  it('shows the page number when the document has no labels', () => {
    render(props({ page: 4 }));
    expect(field().value).toBe('4');
    expect(host.textContent).toContain(t('view.pageNumber', { page: 4, total: 10 }));
  });

  it('shows the page label when the document has labels', () => {
    render(props({ page: 1, labels: ['i', 'ii'] }));
    expect(field().value).toBe('i');
  });

  it('jumps to a valid page number', () => {
    const onGoTo = vi.fn();
    render(props({ onGoTo }));
    typeAndSubmit('7');
    expect(onGoTo).toHaveBeenCalledWith(6);
  });

  it('jumps to a page by its label', () => {
    const onGoTo = vi.fn();
    render(props({ onGoTo, labels: ['i', 'ii', 'iii'] }));
    typeAndSubmit('iii');
    expect(onGoTo).toHaveBeenCalledWith(2);
  });

  it('refuses an invalid page, shows the message and does not move', () => {
    const onGoTo = vi.fn();
    render(props({ onGoTo }));
    typeAndSubmit('42');
    expect(onGoTo).not.toHaveBeenCalled();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(t('view.jumpInvalid', { input: '42', total: 10 }));
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });
});

describe('back and forward', () => {
  it('calls the button handlers, and disables a button with no entry', () => {
    const onBack = vi.fn();
    render(props({ onBack, canBack: true, canForward: false }));
    expect(buttonNamed(t('view.back')).disabled).toBe(false);
    expect(buttonNamed(t('view.forward')).disabled).toBe(true);
    act(() => buttonNamed(t('view.back')).click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('moves back and forward with Alt+Left and Alt+Right', () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    render(props({ onBack, onForward }));
    expect(keydown({ key: 'ArrowLeft', altKey: true }).defaultPrevented).toBe(true);
    keydown({ key: 'ArrowRight', altKey: true });
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it('ignores the arrow keys without Alt', () => {
    const onBack = vi.fn();
    render(props({ onBack }));
    keydown({ key: 'ArrowLeft' });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('focuses the page field with Alt+G', () => {
    render(props());
    keydown({ key: 'g', altKey: true });
    expect(document.activeElement).toBe(field());
  });
});

describe('desktop order', () => {
  it('puts the page on the left and the zoom and view mode on the right', () => {
    render(props({ page: 3, total: 10, zoom: 1.5, layout: 'twoPage' }));
    const start = host.querySelector('.doc-status-start');
    const end = host.querySelector('.doc-status-end');
    expect(start?.textContent).toContain(t('view.pageNumber', { page: 3, total: 10 }));
    expect(start?.textContent).not.toContain('150%');
    expect(end?.textContent).toBe(
      `${t('view.zoomPercent', { percent: 150 })}${t('view.layoutTwoPage')}`,
    );
    expect(host.querySelector('.doc-status-mode')?.textContent).toBe(t('view.layoutTwoPage'));
  });

  it('shows the single column layout when the reader has it', () => {
    render(props({ layout: 'continuous' }));
    expect(host.querySelector('.doc-status-mode')?.textContent).toBe(t('view.layoutSingle'));
  });
});
