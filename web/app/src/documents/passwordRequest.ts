// The password request behind the password dialog (W3.1, W1.2 section 12). openFile asks through
// ask(); the dialog shows the request and answers it. Only the open request is held here, and the
// password itself never enters this store: it is handed to the awaiting caller once and dropped.
import { useSyncExternalStore } from 'react';

export interface PasswordRequest {
  // The file name the dialog shows, so the user knows which document is asking.
  readonly name: string;
}

export interface PasswordPrompt {
  getState(): PasswordRequest | null;
  subscribe(listener: () => void): () => void;
  // Shows the dialog for one file. Resolves with the password, or null when the user cancels.
  ask(name: string): Promise<string | null>;
  // Ends the open request with the answer (null for a cancel).
  answer(password: string | null): void;
}

export function createPasswordPrompt(): PasswordPrompt {
  let request: PasswordRequest | null = null;
  let resolveAnswer: ((password: string | null) => void) | undefined;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    getState: () => request,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ask(name) {
      // The app opens files one after another, so a second request only comes after the first is
      // answered. If one comes anyway, the earlier caller is cancelled rather than left waiting.
      resolveAnswer?.(null);
      return new Promise<string | null>((resolve) => {
        resolveAnswer = resolve;
        request = { name };
        notify();
      });
    },
    answer(password) {
      const resolve = resolveAnswer;
      resolveAnswer = undefined;
      request = null;
      notify();
      resolve?.(password);
    },
  };
}

export const passwordPrompt: PasswordPrompt = createPasswordPrompt();

export function usePasswordRequest(store: PasswordPrompt = passwordPrompt): PasswordRequest | null {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
