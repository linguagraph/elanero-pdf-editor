// The password loop of Insert from file and Replace pages: a locked or wrong password asks again, at
// most PASSWORD_ATTEMPTS times (the engine's limit). Any other error passes through.
import { RpcError } from '../rpc/client';
import { passwordPrompt, type PasswordPrompt } from './passwordRequest';

export const PASSWORD_ATTEMPTS = 5;

// Thrown when the file is still locked after PASSWORD_ATTEMPTS answers.
export class PasswordGaveUp extends Error {
  constructor() {
    super('the file is still locked');
    this.name = 'PasswordGaveUp';
  }
}

export interface Unlocked<T> {
  readonly value: T;
  readonly password: string | null;
}

// Runs attempt(password) until it succeeds, from `first`; null when the user cancels the prompt.
export async function withPassword<T>(
  name: string,
  attempt: (password: string | null) => Promise<T>,
  prompt: PasswordPrompt = passwordPrompt,
  first: string | null = null,
): Promise<Unlocked<T> | null> {
  let password = first;
  for (let asked = 0; ; asked += 1) {
    try {
      return { value: await attempt(password), password };
    } catch (error) {
      const locked =
        error instanceof RpcError && ['PASSWORD_REQUIRED', 'WRONG_PASSWORD'].includes(error.code);
      if (!locked) throw error;
      if (asked >= PASSWORD_ATTEMPTS) throw new PasswordGaveUp();
      const answer = await prompt.ask(name);
      if (answer === null) return null;
      password = answer;
    }
  }
}
