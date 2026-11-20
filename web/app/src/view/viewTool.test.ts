import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetViewTool, setViewTool, type ViewTool, useViewTool } from './viewTool';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each test gets its own tab numbers, since the store is module state.
let nextTab = 1000;
function freshTab(): number {
  nextTab += 1;
  return nextTab;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// Renders the hook for a tab and records each value it returns.
function watch(tabId: number | null): { values: ViewTool[] } {
  const seen: { values: ViewTool[] } = { values: [] };
  function Probe() {
    seen.values.push(useViewTool(tabId));
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return seen;
}

describe('the per-tab view tool', () => {
  it('is Select by default, and Select when there is no tab', () => {
    const tab = freshTab();
    expect(watch(tab).values.at(-1)).toBe('select');
    expect(watch(null).values.at(-1)).toBe('select');
  });

  it('sets and reads the tool of one tab, and the tabs are independent', () => {
    const first = freshTab();
    const second = freshTab();
    setViewTool(first, 'hand');
    expect(watch(first).values.at(-1)).toBe('hand');
    expect(watch(second).values.at(-1)).toBe('select');
  });

  it('notifies a mounted reader when its tool changes, and not when it stays the same', () => {
    const tab = freshTab();
    const seen = watch(tab);
    act(() => setViewTool(tab, 'hand'));
    const count = seen.values.length;
    act(() => setViewTool(tab, 'hand'));
    expect(seen.values.length).toBe(count);
    act(() => setViewTool(tab, 'select'));
    expect(seen.values.at(-1)).toBe('select');
  });

  it('forgets a closed tab, which then reads as Select', () => {
    const tab = freshTab();
    setViewTool(tab, 'hand');
    act(() => forgetViewTool(tab));
    expect(watch(tab).values.at(-1)).toBe('select');
  });
});
