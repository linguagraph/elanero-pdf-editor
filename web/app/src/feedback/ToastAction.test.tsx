import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { ToastRegion } from './ToastRegion';
import { ACTION_EXTRA_MS, AUTO_DISMISS_MS, createToastStore, undoAction } from './toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('toast actions', () => {
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

  function actionButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('.toast-action');
  }

  it('a toast with an Undo action runs it and closes the toast', () => {
    const store = createToastStore();
    const run = vi.fn();
    act(() => root.render(<ToastRegion store={store} />));
    act(() => {
      store.push('success', 'Page deleted', undoAction(run));
    });

    expect(actionButton()?.textContent).toBe(t('toast.undo'));

    act(() => actionButton()?.click());

    expect(run).toHaveBeenCalledTimes(1);
    expect(store.getState().visible).toHaveLength(0);
    expect(container.querySelector('.toast')).toBeNull();
  });

  it('a toast without an action has no action button', () => {
    const store = createToastStore();
    act(() => root.render(<ToastRegion store={store} />));
    act(() => {
      store.push('info', 'Saved');
    });

    expect(container.querySelector('.toast')).not.toBeNull();
    expect(actionButton()).toBeNull();
  });

  it('the Undo label comes from the catalogue', () => {
    expect(undoAction(() => undefined).label).toBe(t('toast.undo'));
  });
});

describe('toast action timing and names', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('keeps a toast with an action for 8 s and a plain toast for 5 s', () => {
    const store = createToastStore();
    act(() => root.render(<ToastRegion store={store} />));
    act(() => {
      store.push('success', 'Plain');
      store.push(
        'success',
        'With undo',
        undoAction(() => undefined),
      );
    });

    act(() => vi.advanceTimersByTime(AUTO_DISMISS_MS));
    expect(container.textContent).not.toContain('Plain');
    expect(container.textContent).toContain('With undo');

    act(() => vi.advanceTimersByTime(ACTION_EXTRA_MS - 1));
    expect(container.textContent).toContain('With undo');
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).not.toContain('With undo');
  });

  it('names the Undo button after the toast text', () => {
    const store = createToastStore();
    act(() => root.render(<ToastRegion store={store} />));
    act(() => {
      store.push(
        'info',
        'Comment added.',
        undoAction(() => undefined),
      );
    });
    const button = container.querySelector<HTMLButtonElement>('.toast-action');
    expect(button?.getAttribute('aria-label')).toBe(
      t('toast.actionNamed', { action: t('toast.undo'), text: 'Comment added.' }),
    );
    expect(button?.getAttribute('aria-label')).toBe('Undo: Comment added.');
  });

  it('does not move focus to a new toast', () => {
    const store = createToastStore();
    act(() => root.render(<ToastRegion store={store} />));
    const before = document.activeElement;
    act(() => {
      store.push(
        'info',
        'Comment added.',
        undoAction(() => undefined),
      );
    });
    expect(document.activeElement).toBe(before);
  });
});
