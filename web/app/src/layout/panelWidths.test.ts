import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTHS,
  maxPanelWidth,
  PANEL_WIDTHS_STORAGE_KEY,
  readPanelWidths,
  writePanelWidth,
} from './panelWidths';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('clampPanelWidth', () => {
  it('raises a width below the 160 px minimum to the minimum', () => {
    expect(clampPanelWidth(159, 1366)).toBe(160);
    expect(clampPanelWidth(10, 1366)).toBe(160);
  });

  it('keeps a width at the minimum as it is', () => {
    expect(clampPanelWidth(160, 1366)).toBe(160);
  });

  it('caps a width at 40 % of the window', () => {
    expect(clampPanelWidth(9999, 1100)).toBe(440);
    expect(clampPanelWidth(441, 1100)).toBe(440);
    expect(clampPanelWidth(440, 1100)).toBe(440);
  });

  it('never caps below the minimum, even in a very narrow window', () => {
    expect(clampPanelWidth(300, 300)).toBe(160);
  });

  it('keeps the 40 % cap on the wide tier', () => {
    expect(clampPanelWidth(300, 1100, 'wide')).toBe(300);
    expect(clampPanelWidth(9999, 1100, 'wide')).toBe(440);
  });

  it('gives a drawer its default width on a phone or tablet, not the 40 % share', () => {
    expect(clampPanelWidth(220, 375, 'phone')).toBe(220);
    expect(clampPanelWidth(220, 400, 'phone')).toBe(220);
    expect(clampPanelWidth(260, 400, 'phone')).toBe(260);
    expect(clampPanelWidth(260, 375, 'tablet')).toBe(260);
  });

  it('caps a drawer at the window less both rails and a margin', () => {
    expect(clampPanelWidth(9999, 400, 'phone')).toBe(288);
    expect(maxPanelWidth(375, 'phone')).toBe(263);
  });

  it('keeps the drawer maximum above the minimum at phone widths', () => {
    expect(maxPanelWidth(320, 'phone')).toBeGreaterThan(160);
    expect(maxPanelWidth(375, 'phone')).toBeGreaterThan(160);
    expect(maxPanelWidth(400, 'phone')).toBeGreaterThan(160);
  });
});

describe('readPanelWidths and writePanelWidth', () => {
  it('gives the desktop defaults when nothing is remembered', () => {
    expect(readPanelWidths()).toEqual({ left: 220, right: 260 });
    expect(DEFAULT_PANEL_WIDTHS).toEqual({ left: 220, right: 260 });
  });

  it('remembers each side on its own', () => {
    writePanelWidth('left', 300);
    writePanelWidth('right', 200);
    expect(readPanelWidths()).toEqual({ left: 300, right: 200 });
    writePanelWidth('left', 180);
    expect(readPanelWidths()).toEqual({ left: 180, right: 200 });
  });

  it('gives the defaults for bad JSON', () => {
    window.localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, '{not json');
    expect(readPanelWidths()).toEqual({ left: 220, right: 260 });
  });

  it('gives the default for a side whose stored value is not a number', () => {
    window.localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify({ left: 'wide' }));
    expect(readPanelWidths()).toEqual({ left: 220, right: 260 });
  });

  it('gives the defaults when the storage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readPanelWidths()).toEqual({ left: 220, right: 260 });
  });

  it('does not throw when the storage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => {
      writePanelWidth('left', 300);
    }).not.toThrow();
  });
});
