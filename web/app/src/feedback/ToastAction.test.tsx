import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { ToastRegion } from './ToastRegion';
import { createToastStore, undoAction } from './toasts';

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
