import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppFrame } from './AppFrame';
import { Panel } from './Panel';
import { PanelResizer, RESIZE_STEP_PX } from './PanelResizer';
import { PANEL_WIDTHS_STORAGE_KEY } from './panelWidths';
import { closePanel } from './sidePanels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  closePanel('left');
  closePanel('right');
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    root.unmount();
  });
  host.remove();
});

// Dispatches a pointer event the way the browser does (a MouseEvent carrying the pointer fields).
function pointer(target: Element, type: string, x: number, button = 0): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

function key(target: Element, name: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
  );
}

function separator(side: 'left' | 'right'): HTMLElement {
  const el = host.querySelector<HTMLElement>(`.app-panel-resizer-${side}`);
  if (el === null) throw new Error(`no ${side} separator`);
  return el;
}

// A stand-in for AppFrame that keeps the width in state, as the frame does.
function Harness({
  side,
  onChange,
  onCommit,
}: {
  side: 'left' | 'right';
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const [width, setWidth] = useState(220);
  return (
    <PanelResizer
      side={side}
      value={width}
      min={160}
      max={440}
      onChange={(next) => {
        setWidth(next);
        onChange(next);
      }}
      onCommit={(next) => {
        onCommit(next);
      }}
    />
  );
}

describe('PanelResizer keyboard', () => {
  it('moves the value by 16 px per arrow press and saves each key press', () => {
    const onCommit = vi.fn();
    act(() => {
      root.render(<Harness side="left" onChange={vi.fn()} onCommit={onCommit} />);
    });
    const el = separator('left');
    expect(el.getAttribute('aria-valuenow')).toBe('220');
    act(() => {
      key(el, 'ArrowRight');
    });
    expect(el.getAttribute('aria-valuenow')).toBe(String(220 + RESIZE_STEP_PX));
    expect(onCommit).toHaveBeenLastCalledWith(236);
    act(() => {
      key(el, 'ArrowLeft');
    });
    expect(el.getAttribute('aria-valuenow')).toBe('220');
    expect(onCommit).toHaveBeenLastCalledWith(220);
  });

  it('moves the right panel the other way, as a drag does', () => {
    const onCommit = vi.fn();
    act(() => {
      root.render(<Harness side="right" onChange={vi.fn()} onCommit={onCommit} />);
    });
    act(() => {
      key(separator('right'), 'ArrowRight');
    });
    expect(onCommit).toHaveBeenLastCalledWith(204);
  });

  it('goes to the minimum on Home and the maximum on End', () => {
    const onCommit = vi.fn();
    act(() => {
      root.render(<Harness side="left" onChange={vi.fn()} onCommit={onCommit} />);
    });
    act(() => {
      key(separator('left'), 'Home');
    });
    expect(onCommit).toHaveBeenLastCalledWith(160);
    act(() => {
      key(separator('left'), 'End');
    });
    expect(onCommit).toHaveBeenLastCalledWith(440);
  });

  it('does nothing when the value is already at the limit', () => {
    const onCommit = vi.fn();
    act(() => {
      root.render(<Harness side="left" onChange={vi.fn()} onCommit={onCommit} />);
    });
    act(() => {
      key(separator('left'), 'Home');
    });
    onCommit.mockClear();
    act(() => {
      key(separator('left'), 'ArrowLeft');
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('PanelResizer drag', () => {
  it('follows each move and saves once when the drag ends', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    act(() => {
      root.render(<Harness side="left" onChange={onChange} onCommit={onCommit} />);
    });
    const el = separator('left');
    act(() => {
      pointer(el, 'pointerdown', 100);
    });
    act(() => {
      pointer(el, 'pointermove', 130);
    });
    act(() => {
      pointer(el, 'pointermove', 200);
    });
    act(() => {
      pointer(el, 'pointerup', 200);
    });
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([250, 320]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(320);
  });

  it('widens the right panel when dragged left', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<Harness side="right" onChange={onChange} onCommit={vi.fn()} />);
    });
    const el = separator('right');
    act(() => {
      pointer(el, 'pointerdown', 300);
    });
    act(() => {
      pointer(el, 'pointermove', 260);
    });
    act(() => {
      pointer(el, 'pointerup', 260);
    });
    expect(onChange).toHaveBeenCalledWith(260);
  });

  it('stops at the minimum and does not save a drag that changed nothing', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    act(() => {
      root.render(<Harness side="left" onChange={onChange} onCommit={onCommit} />);
    });
    const el = separator('left');
    act(() => {
      pointer(el, 'pointerdown', 300);
    });
    act(() => {
      pointer(el, 'pointermove', 0);
    });
    act(() => {
      pointer(el, 'pointerup', 0);
    });
    expect(onChange).toHaveBeenLastCalledWith(160);
    expect(onCommit).toHaveBeenCalledWith(160);
    onCommit.mockClear();
    act(() => {
      pointer(el, 'pointerdown', 300);
    });
    act(() => {
      pointer(el, 'pointerup', 300);
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores a press with a button other than the primary one', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<Harness side="left" onChange={onChange} onCommit={vi.fn()} />);
    });
    const el = separator('left');
    act(() => {
      pointer(el, 'pointerdown', 100, 2);
    });
    act(() => {
      pointer(el, 'pointermove', 200);
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('AppFrame panel widths', () => {
  function setWindowWidth(width: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }

  function renderFrame(): void {
    act(() => {
      root.render(
        <AppFrame
          header={<span>top</span>}
          leftPanel={
            <Panel title="Pages" onClose={() => closePanel('left')}>
              <button type="button">Page one</button>
            </Panel>
          }
        >
          <div>page</div>
        </AppFrame>,
      );
    });
  }

  it.each([375, 400])('shows a phone drawer at its default width at %i px', (width) => {
    setWindowWidth(width);
    renderFrame();
    const panel = host.querySelector<HTMLElement>('.app-panel-left');
    expect(panel?.style.width).toBe('220px');
  });

  it('keeps a stored 260 px drawer at 260 px at 400 px and lets it be resized', () => {
    setWindowWidth(400);
    window.localStorage.setItem(
      PANEL_WIDTHS_STORAGE_KEY,
      JSON.stringify({ left: 260, right: 260 }),
    );
    renderFrame();
    const panel = host.querySelector<HTMLElement>('.app-panel-left');
    expect(panel?.style.width).toBe('260px');
    const el = separator('left');
    expect(Number(el.getAttribute('aria-valuemax'))).toBeGreaterThan(
      Number(el.getAttribute('aria-valuemin')),
    );
    act(() => {
      key(el, 'ArrowLeft');
    });
    expect(panel?.style.width).toBe('244px');
    act(() => {
      key(el, 'ArrowRight');
    });
    expect(panel?.style.width).toBe('260px');
  });

  it('sizes the panel from the remembered width and saves once per drag end', () => {
    setWindowWidth(1366);
    window.localStorage.setItem(
      PANEL_WIDTHS_STORAGE_KEY,
      JSON.stringify({ left: 300, right: 260 }),
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderFrame();
    const panel = host.querySelector<HTMLElement>('.app-panel-left');
    expect(panel?.style.width).toBe('300px');
    const el = separator('left');
    act(() => {
      pointer(el, 'pointerdown', 100);
    });
    act(() => {
      pointer(el, 'pointermove', 140);
    });
    act(() => {
      pointer(el, 'pointermove', 200);
    });
    expect(panel?.style.width).toBe('400px');
    expect(setItem).not.toHaveBeenCalled();
    act(() => {
      pointer(el, 'pointerup', 200);
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? '{}')).toEqual({
      left: 400,
      right: 260,
    });
  });

  it('caps a remembered width at 40 % of a wide window and keeps the stored value', () => {
    setWindowWidth(1366);
    window.localStorage.setItem(
      PANEL_WIDTHS_STORAGE_KEY,
      JSON.stringify({ left: 600, right: 260 }),
    );
    renderFrame();
    expect(host.querySelector<HTMLElement>('.app-panel-left')?.style.width).toBe('546px');
    expect(separator('left').getAttribute('aria-valuemax')).toBe('546');
    expect(JSON.parse(window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? '{}').left).toBe(
      600,
    );
  });
});
