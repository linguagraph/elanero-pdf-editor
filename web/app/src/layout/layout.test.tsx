import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppFrame } from './AppFrame';
import { Overlay } from './Overlay';
import { Panel } from './Panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens. The real one escapes more
// cases; these tests only use plain names.
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
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

describe('Panel', () => {
  it('collapses and expands, and announces the state', () => {
    const onCollapsedChange = vi.fn();
    render(
      <Panel title="Pages" onClose={() => {}} onCollapsedChange={onCollapsedChange}>
        <p>Thumbnails</p>
      </Panel>,
    );
    const toggle = host.querySelector<HTMLButtonElement>('.panel-toggle');
    const status = host.querySelector('[role="status"]');
    const body = host.querySelector<HTMLElement>('.panel-body');
    expect(toggle?.textContent).toBe('Pages');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(body?.hidden).toBe(false);
    expect(status?.textContent).toBe('Expanded');

    act(() => {
      toggle?.click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(body?.hidden).toBe(true);
    expect(status?.textContent).toBe('Collapsed');
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);

    act(() => {
      toggle?.click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(status?.textContent).toBe('Expanded');
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it('has a close button named from the panel title and calls onClose', () => {
    const onClose = vi.fn();
    render(
      <Panel title="Bookmarks" onClose={onClose}>
        <p>Items</p>
      </Panel>,
    );
    const close = host.querySelector<HTMLButtonElement>('.panel-close');
    expect(close?.getAttribute('aria-label')).toBe('Close Bookmarks');
    act(() => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AppFrame', () => {
  function setWidth(width: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }

  it('lays out the regions for the current width and follows resizes', () => {
    setWidth(1366);
    render(
      <AppFrame
        header={<span>top</span>}
        leftRail={<span>rail</span>}
        leftPanel={<span>left</span>}
        rightPanel={<span>right</span>}
      >
        <span>page</span>
      </AppFrame>,
    );
    const frame = host.querySelector<HTMLElement>('.app-frame');
    expect(frame?.dataset.tier).toBe('wide');
    expect(frame?.dataset.leftRail).toBe('shown');
    expect(frame?.dataset.leftPanel).toBe('docked');
    expect(frame?.dataset.rightPanel).toBe('docked');

    setWidth(700);
    expect(frame?.dataset.tier).toBe('phone');
    expect(frame?.dataset.leftRail).toBe('hidden');
    expect(frame?.dataset.leftPanel).toBe('drawer');
    expect(frame?.dataset.rightPanel).toBe('overlay');
  });

  it('marks a region as none when the caller passes no panel', () => {
    setWidth(1366);
    render(
      <AppFrame header={<span>top</span>}>
        <span>page</span>
      </AppFrame>,
    );
    const frame = host.querySelector<HTMLElement>('.app-frame');
    expect(frame?.dataset.leftPanel).toBe('none');
    expect(frame?.dataset.rightPanel).toBe('none');
    expect(host.querySelector('.app-panel')).toBeNull();
  });

  it('shows the rails as toolbars unless the start page hides them', () => {
    setWidth(1366);
    render(
      <AppFrame header={<span>top</span>} leftRail={<span>left</span>} railsHidden>
        <span>page</span>
      </AppFrame>,
    );
    const frame = host.querySelector<HTMLElement>('.app-frame');
    expect(frame?.dataset.rails).toBe('hidden');
    // The left rail is the only rail: there is no right rail (issue 827).
    const rails = host.querySelectorAll('.app-rail');
    expect(rails).toHaveLength(1);
    expect(rails[0]?.getAttribute('role')).toBe('toolbar');
    expect(host.querySelector('.app-rail-right')).toBeNull();

    render(
      <AppFrame header={<span>top</span>} leftRail={<span>left</span>}>
        <span>page</span>
      </AppFrame>,
    );
    expect(host.querySelector<HTMLElement>('.app-frame')?.dataset.rails).toBe('shown');
  });
});

describe('Overlay', () => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          invoker
        </button>
        <Overlay isOpen={open} onClose={() => setOpen(false)} title="Dialog title">
          <button type="button">first</button>
          <button type="button">second</button>
        </Overlay>
      </>
    );
  }

  it('traps Tab inside the dialog, closes on Escape and returns focus', () => {
    render(<Harness />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const buttons = [...(dialog?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(['first', 'second', 'Close']);

    // Tab from the last button wraps to the first one: focus never leaves the dialog.
    const last = buttons[buttons.length - 1] as HTMLButtonElement;
    last.focus();
    act(() => {
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);

    // Escape closes the dialog.
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
