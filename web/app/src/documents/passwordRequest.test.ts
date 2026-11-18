import { describe, expect, it, vi } from 'vitest';
import { createPasswordPrompt } from './passwordRequest';

describe('password request', () => {
  it('holds the file name while a request is open, and resolves with the answer', async () => {
    const store = createPasswordPrompt();
    const listener = vi.fn();
    store.subscribe(listener);

    const pending = store.ask('locked.pdf');
    expect(store.getState()).toEqual({ name: 'locked.pdf' });
    expect(listener).toHaveBeenCalledTimes(1);

    store.answer('secret');
    await expect(pending).resolves.toBe('secret');
    expect(store.getState()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('resolves with null when the user cancels', async () => {
    const store = createPasswordPrompt();
    const pending = store.ask('locked.pdf');
    store.answer(null);
    await expect(pending).resolves.toBeNull();
  });

  it('cancels an earlier request that a new one replaces, so no caller waits forever', async () => {
    const store = createPasswordPrompt();
    const first = store.ask('first.pdf');
    const second = store.ask('second.pdf');
    await expect(first).resolves.toBeNull();
    expect(store.getState()).toEqual({ name: 'second.pdf' });
    store.answer('pw');
    await expect(second).resolves.toBe('pw');
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const store = createPasswordPrompt();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    void store.ask('locked.pdf');
    expect(listener).not.toHaveBeenCalled();
  });
});
