import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import type { RedactionMark, RedactionSnapshot } from './controller';
import { RedactionBar, type RedactionBarProps } from './RedactionBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (char) => '\\' + char) },
  });
}

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

// One mark of the document, as the controller holds it.
function docMark(name: string): RedactionMark {
  return {
    page: 0,
    name,
    rect: { x0: 1, y0: 2, x1: 30, y1: 40 },
    fill: null,
    overlayText: '',
    textColor: null,
    contents: '',
    author: '',
    locked: false,
  };
}

function snapshot(overrides: Partial<RedactionSnapshot> = {}): RedactionSnapshot {
  return {
    active: false,
    marks: [docMark('m1')],
    selected: [],
    busy: false,
    loaded: true,
    ...overrides,
  };
}

const WITH_MARKS: RedactionSnapshot = snapshot();

function render(props: Partial<RedactionBarProps> = {}) {
  const full: RedactionBarProps = {
    state: WITH_MARKS,
    onToggle: vi.fn(),
    onClear: vi.fn(),
    onApply: vi.fn(),
    ...props,
  };
  act(() => root.render(<RedactionBar {...full} />));
  return full;
}

// The buttons with a given text, in the bar or in an open dialog (a dialog is drawn in the body).
function buttonNamed(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button named ${text}`);
  return found;
}

function press(text: string) {
  act(() => buttonNamed(text).click());
}

describe('RedactionBar (W7.4): apply asks for confirmation', () => {
  it('does nothing when the confirmation is cancelled', () => {
    const props = render();
    press(t('redact.apply'));
    press(t('redact.confirm.cancel'));
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('runs the apply once the user confirms', () => {
    const props = render();
    press(t('redact.apply'));
    press(t('redact.confirm.apply'));
    expect(props.onApply).toHaveBeenCalledTimes(1);
  });

  it('keeps Apply and Clear off with no marks, and off while a job runs', () => {
    render({ state: snapshot({ marks: [] }) });
    expect(buttonNamed(t('redact.apply')).disabled).toBe(true);
    expect(buttonNamed(t('redact.clear')).disabled).toBe(true);
    render({ state: snapshot({ busy: true }) });
    expect(buttonNamed(t('redact.apply')).disabled).toBe(true);
  });

  it('shows the mark tool as pressed while it is on', () => {
    render({ state: snapshot({ active: true }) });
    expect(buttonNamed(t('redact.mark')).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('RedactionBar (W7.4b): the count is the document marks', () => {
  it('counts the marks of the document, the ones in the file too', () => {
    render({ state: snapshot({ marks: [docMark('m1'), docMark('m2')] }) });
    expect(container.textContent).toContain(t('redact.count', { count: 2 }));
  });
});
