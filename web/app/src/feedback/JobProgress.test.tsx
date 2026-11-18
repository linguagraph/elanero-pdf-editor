import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobProgress } from './JobProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('JobProgress', () => {
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

  it('renders a determinate bar with the percentage when one is given', () => {
    act(() => {
      root.render(<JobProgress label="Compressing" percent={42.4} onCancel={() => undefined} />);
    });
    const bar = host.querySelector<HTMLProgressElement>('progress');
    expect(bar?.getAttribute('aria-label')).toBe('Compressing');
    expect(bar?.value).toBe(42);
    expect(bar?.max).toBe(100);
    expect(host.querySelector('.job-status')?.textContent).toBe('42% done');
  });

  it('renders an indeterminate bar when no percentage is given', () => {
    act(() => {
      root.render(<JobProgress label="Printing" onCancel={() => undefined} />);
    });
    const bar = host.querySelector<HTMLProgressElement>('progress');
    expect(bar?.hasAttribute('value')).toBe(false);
    expect(host.querySelector('.job-status')?.textContent).toBe('Working');
  });

  it('clamps a percentage outside 0 to 100', () => {
    act(() => {
      root.render(<JobProgress label="Export" percent={140} onCancel={() => undefined} />);
    });
    expect(host.querySelector<HTMLProgressElement>('progress')?.value).toBe(100);
  });

  it('calls the cancel handler when Cancel is pressed', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(<JobProgress label="Export" percent={10} onCancel={onCancel} />);
    });
    const cancel = host.querySelector<HTMLButtonElement>('.job-cancel');
    expect(cancel?.textContent).toBe('Cancel');
    act(() => {
      cancel?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
