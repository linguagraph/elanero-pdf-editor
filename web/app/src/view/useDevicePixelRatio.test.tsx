import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDevicePixelRatio } from './useDevicePixelRatio';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia. The fake keeps every registered change listener, so a test can fire a
// ratio change the way a browser does when a resolution query stops matching.
interface Registration {
  readonly query: string;
  readonly listener: () => void;
}
let registrations: Registration[] = [];

function setRatio(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

// Moves the window to a screen with another ratio: the ratio changes, then each registered query
// reports the change (every one of them was armed at the old ratio, so each stops matching).
function changeRatio(value: number): void {
  setRatio(value);
  const current = [...registrations];
  act(() => {
    for (const registration of current) registration.listener();
  });
}

function Probe({ onRender }: { onRender: (ratio: number) => void }) {
  const ratio = useDevicePixelRatio();
  onRender(ratio);
  return null;
}

let host: HTMLDivElement;
let root: Root;
let originalRatio: number;

beforeEach(() => {
  originalRatio = window.devicePixelRatio;
  registrations = [];
  window.matchMedia = vi.fn((query: string) => {
    return {
      matches: false,
      media: query,
      addEventListener: (_type: string, listener: () => void) => {
        registrations.push({ query, listener });
      },
      removeEventListener: (_type: string, listener: () => void) => {
        registrations = registrations.filter((r) => r.listener !== listener);
      },
    } as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;
  setRatio(1);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setRatio(originalRatio);
});

describe('useDevicePixelRatio', () => {
  it('returns the ratio the window has at mount', () => {
    setRatio(2);
    const seen: number[] = [];
    act(() => root.render(<Probe onRender={(ratio) => seen.push(ratio)} />));
    expect(seen.at(-1)).toBe(2);
  });

  it('re-renders with the new ratio and re-arms the query at that ratio', () => {
    const seen: number[] = [];
    act(() => root.render(<Probe onRender={(ratio) => seen.push(ratio)} />));
    changeRatio(1.5);
    expect(seen.at(-1)).toBe(1.5);
    // Only the query for the new ratio is still listening; the old one was removed.
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.query).toBe('(resolution: 1.5dppx)');
  });

  it('does not re-render when a resize leaves the ratio unchanged', () => {
    const onRender = vi.fn();
    act(() => root.render(<Probe onRender={onRender} />));
    const before = onRender.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onRender).toHaveBeenCalledTimes(before);
  });

  it('removes its listeners on unmount', () => {
    act(() => root.render(<Probe onRender={() => undefined} />));
    expect(registrations).toHaveLength(1);
    act(() => root.unmount());
    expect(registrations).toHaveLength(0);
    // The root is unmounted now; afterEach must not unmount it again.
    root = createRoot(host);
  });
});
