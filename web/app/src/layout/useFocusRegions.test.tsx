import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppFrame } from './AppFrame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A shell with a control in every region, in the desktop order. The status bar and the panels are
// optional so the tests can check the skipped regions.
function Shell({
  withStatus = true,
  withLeftPanel = false,
}: {
  withStatus?: boolean;
  withLeftPanel?: boolean;
}) {
  return (
    <AppFrame
      header={<button type="button">Open</button>}
      leftRail={<button type="button">Pages</button>}
      leftPanel={withLeftPanel ? <button type="button">Thumbnail</button> : undefined}
      rightRail={<button type="button">Organize</button>}
      statusBar={withStatus ? <button type="button">Job</button> : undefined}
    >
      <button type="button">First</button>
      <button type="button">Second</button>
      <section data-region="notifications">
        <button type="button">Undo</button>
      </section>
    </AppFrame>
  );
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
});

function render(element: ReactElement): void {
  act(() => {
    root.render(element);
  });
}

function active(): string | null {
  return document.activeElement?.textContent ?? null;
}

// Presses a key on the focused element; returns whether the default was prevented.
function press(key: string, options: { shift?: boolean } = {}): boolean {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: options.shift === true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

function focusButton(text: string): void {
  const button = Array.from(document.querySelectorAll('button')).find(
    (node) => node.textContent === text,
  );
  act(() => {
    button?.focus();
  });
}

describe('F6 and Shift+F6', () => {
  it('cycles ribbon, left, page, right, status and notifications in order', () => {
    render(<Shell />);
    focusButton('Open');
    const seen: (string | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      press('F6');
      seen.push(active());
    }
    expect(seen).toEqual(['Pages', 'First', 'Organize', 'Job', 'Undo']);
  });

  it('Shift+F6 walks the same order backwards', () => {
    render(<Shell />);
    focusButton('Open');
    press('F6', { shift: true });
    expect(active()).toBe('Undo');
    press('F6', { shift: true });
    expect(active()).toBe('Job');
  });

  it('skips a region with nothing to focus', () => {
    render(<Shell withStatus={false} />);
    focusButton('First');
    press('F6');
    expect(active()).toBe('Organize');
  });

  it('puts the keyboard back where it was when it left a region', () => {
    render(<Shell />);
    focusButton('Second');
    press('F6');
    expect(active()).toBe('Organize');
    press('F6', { shift: true });
    expect(active()).toBe('Second');
  });

  it('still cycles from inside a text field', () => {
    render(
      <AppFrame header={<button type="button">Open</button>}>
        <input aria-label="Search text" />
        <button type="button">Next</button>
      </AppFrame>,
    );
    const input = document.querySelector('input');
    act(() => {
      input?.focus();
    });
    press('F6');
    expect(active()).toBe('Open');
  });

  it('prevents the default action of F6', () => {
    render(<Shell />);
    focusButton('Open');
    expect(press('F6')).toBe(true);
  });

  it('ignores other keys', () => {
    render(<Shell />);
    focusButton('Open');
    expect(press('F5')).toBe(false);
    expect(active()).toBe('Open');
  });
});

describe('Skip to document', () => {
  it('is the first control of the frame and moves focus to the page', () => {
    render(<Shell />);
    const skip = document.querySelector<HTMLAnchorElement>('.app-skip-link');
    expect(skip?.textContent).toBe('Skip to document');
    expect(skip?.getAttribute('href')).toBe('#app-page-area');
    expect(document.querySelector('.app-frame')?.firstElementChild).toBe(skip);
    act(() => {
      skip?.click();
    });
    expect(active()).toBe('First');
  });

  it('falls back to the page area when it holds no control', () => {
    render(
      <AppFrame header={<span>top</span>}>
        <p>Start</p>
      </AppFrame>,
    );
    act(() => {
      document.querySelector<HTMLAnchorElement>('.app-skip-link')?.click();
    });
    expect(document.activeElement?.id).toBe('app-page-area');
  });
});
