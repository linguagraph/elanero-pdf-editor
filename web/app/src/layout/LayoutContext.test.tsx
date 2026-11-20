import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REGISTRY } from '../commands/catalog';
import type { CommandState } from '../commands/registry';
import { Ribbon } from '../ribbon/Ribbon';
import { AppFrame } from './AppFrame';
import { useLayoutRegions } from './LayoutContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

// Shows the tier that a consumer of the context reads.
function Probe() {
  return <span className="probe">{useLayoutRegions().tier}</span>;
}

const NO_DOCUMENT: CommandState = {
  hasDocument: false,
  hasRecentFiles: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(),
  ribbonCompact: false,
  ribbonCollapsed: false,
  viewTool: 'select',
};

describe('layout context tiers', () => {
  // Lower bounds are inclusive: 1280 is wide, 1279 medium, 1024 medium, 1023 tablet, 768 tablet,
  // 767 phone (W1.6 section 8).
  it.each([
    [1280, 'wide'],
    [1279, 'medium'],
    [1024, 'medium'],
    [1023, 'tablet'],
    [768, 'tablet'],
    [767, 'phone'],
  ])('gives the %i px window the %s tier to every consumer', (width, tier) => {
    setWidth(width);
    render(
      <AppFrame header={<Probe />}>
        <Probe />
      </AppFrame>,
    );
    const probes = host.querySelectorAll('.probe');
    expect(probes).toHaveLength(2);
    expect([...probes].map((probe) => probe.textContent)).toEqual([tier, tier]);
    expect(host.querySelector<HTMLElement>('.app-frame')?.dataset.tier).toBe(tier);
  });

  it('follows a resize for every consumer at once', () => {
    setWidth(1366);
    render(
      <AppFrame header={<Probe />}>
        <Probe />
      </AppFrame>,
    );
    setWidth(900);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect([...host.querySelectorAll('.probe')].map((probe) => probe.textContent)).toEqual([
      'tablet',
      'tablet',
    ]);
  });

  it('reads the window width when rendered outside a frame', () => {
    setWidth(500);
    render(<Probe />);
    expect(host.querySelector('.probe')?.textContent).toBe('phone');
  });
});

describe('ribbon collapse follows the context', () => {
  it('collapses below 768 px', () => {
    setWidth(767);
    render(<Ribbon registry={REGISTRY} state={NO_DOCUMENT} handlers={{}} />);
    expect(host.querySelector('.ribbon-collapsed')).not.toBeNull();
  });

  it('collapses at the tablet tier, from 768 px to 1023 px', () => {
    setWidth(768);
    render(<Ribbon registry={REGISTRY} state={NO_DOCUMENT} handlers={{}} />);
    expect(host.querySelector('.ribbon-collapsed')).not.toBeNull();
  });

  it('is compact, not collapsed, from 1024 px', () => {
    setWidth(1024);
    render(<Ribbon registry={REGISTRY} state={NO_DOCUMENT} handlers={{}} />);
    expect(host.querySelector('.ribbon-collapsed')).toBeNull();
    expect(host.querySelector('.ribbon')?.getAttribute('data-form')).toBe('compact');
  });
});
