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
    zoom: 1,
    layout: 'continuous',
    canBack: false,
    canForward: false,
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

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
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

describe('status bar', () => {
  it('has no page field: the canvas pill carries the page jump', () => {
    render(props());
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
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

  it('leaves Alt+Left and Alt+Right to the registry commands, so a key runs one handler', () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    render(props({ onBack, onForward, canBack: true, canForward: true }));
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(onBack).not.toHaveBeenCalled();
    expect(onForward).not.toHaveBeenCalled();
  });
});

describe('desktop order', () => {
  it('puts Back and Forward on the left and the zoom and view mode on the right', () => {
    render(props({ zoom: 1.5, layout: 'twoPage' }));
    const start = host.querySelector('.doc-status-start');
    const end = host.querySelector('.doc-status-end');
    expect(start?.textContent).toBe(`${t('view.back')}${t('view.forward')}`);
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
