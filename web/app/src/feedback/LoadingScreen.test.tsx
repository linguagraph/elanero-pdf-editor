import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineLoadError } from '../engine/errors';
import { EngineLoadingScreen, LoadingScreen } from './LoadingScreen';
import { createEngineLoadStore, type LoadState } from './engineLoad';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LoadingScreen', () => {
  let host: HTMLDivElement;
  let root: Root;

  const show = (state: LoadState, onRetry = () => undefined) => {
    act(() => {
      root.render(<LoadingScreen state={state} onRetry={onRetry} />);
    });
  };

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

  it('renders nothing before the load starts and after it is ready', () => {
    show({ status: 'idle' });
    expect(host.innerHTML).toBe('');
    show({ status: 'ready' });
    expect(host.innerHTML).toBe('');
  });

  it('lists the stages in order and marks the done and current ones', () => {
    show({ status: 'loading', stage: 'engine' });
    const items = [...host.querySelectorAll('li')];
    expect(items.map((item) => item.dataset['state'])).toEqual([
      'done',
      'done',
      'current',
      'pending',
    ]);
    expect(items.map((item) => item.querySelector('span')?.textContent)).toEqual([
      'Loading the Python runtime',
      'Loading the PDF libraries',
      'Starting the PDF engine',
      'Ready',
    ]);
    expect(items[2]?.getAttribute('aria-current')).toBe('step');
    expect(host.querySelector('progress')?.value).toBe(2);
  });

  it('shows the failed stage message with a Retry button that calls the handler', () => {
    const onRetry = vi.fn();
    show({ status: 'failed', stage: 'packages' }, onRetry);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The PDF libraries could not be loaded. Check your connection, then try again.',
    );
    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again',
    );
    act(() => {
      retry?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('EngineLoadingScreen', () => {
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

  it('follows the stage events of a load and retries through the registered starter', () => {
    const store = createEngineLoadStore();
    const starter = vi.fn(() => {
      store.stage('pyodide');
    });
    store.setStarter(starter);
    act(() => {
      root.render(<EngineLoadingScreen store={store} />);
    });
    expect(host.innerHTML).toBe('');

    act(() => {
      store.stage('pyodide');
      store.stage('packages');
    });
    expect(host.querySelector('li[aria-current="step"]')?.textContent).toContain(
      'Loading the PDF libraries',
    );

    act(() => {
      store.fail(new EngineLoadError('packages', 'network down'));
    });
    const retry = host.querySelector('button');
    act(() => {
      retry?.click();
    });
    expect(starter).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ status: 'loading', stage: 'pyodide' });

    act(() => {
      store.stage('ready');
    });
    expect(host.innerHTML).toBe('');
  });

  it('does nothing on retry when no starter is registered', () => {
    const store = createEngineLoadStore();
    store.fail(new EngineLoadError('pyodide', 'no network'));
    store.retry();
    expect(store.getState()).toEqual({ status: 'failed', stage: 'pyodide' });
  });
});
