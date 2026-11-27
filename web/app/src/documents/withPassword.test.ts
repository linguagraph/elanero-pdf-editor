import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '../rpc/client';
import type { PasswordPrompt } from './passwordRequest';
import { PASSWORD_ATTEMPTS, PasswordGaveUp, withPassword } from './withPassword';

// A prompt whose answers are queued: each ask() takes the next one (null cancels).
function promptAnswering(...answers: (string | null)[]) {
  const ask = vi.fn(async () => (answers.length > 0 ? (answers.shift() ?? null) : null));
  return { prompt: { ask } as unknown as PasswordPrompt, ask };
}

function locked(code: 'PASSWORD_REQUIRED' | 'WRONG_PASSWORD' = 'PASSWORD_REQUIRED') {
  return new RpcError(code, 'password protected');
}

describe('withPassword', () => {
  it('returns the value and no password when the first attempt works', async () => {
    const { prompt, ask } = promptAnswering();
    const won = await withPassword('a.pdf', async () => 'done', prompt);
    expect(won).toEqual({ value: 'done', password: null });
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks on PASSWORD_REQUIRED and returns the password that worked', async () => {
    const { prompt, ask } = promptAnswering('secret');
    const attempt = vi.fn(async (password: string | null) => {
      if (password !== 'secret') throw locked();
      return 'open';
    });
    const won = await withPassword('a.pdf', attempt, prompt);
    expect(won).toEqual({ value: 'open', password: 'secret' });
    expect(ask).toHaveBeenCalledWith('a.pdf');
    expect(attempt.mock.calls.map((call) => call[0])).toEqual([null, 'secret']);
  });

  it('asks again on WRONG_PASSWORD too', async () => {
    const { prompt, ask } = promptAnswering('wrong', 'right');
    const attempt = async (password: string | null) => {
      if (password !== 'right') throw locked('WRONG_PASSWORD');
      return password;
    };
    await expect(withPassword('a.pdf', attempt, prompt)).resolves.toEqual({
      value: 'right',
      password: 'right',
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('uses a first password before asking', async () => {
    const { prompt, ask } = promptAnswering();
    const won = await withPassword('a.pdf', async (password) => password, prompt, 'known');
    expect(won).toEqual({ value: 'known', password: 'known' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('gives up with PasswordGaveUp after PASSWORD_ATTEMPTS answers', async () => {
    const { prompt, ask } = promptAnswering('a', 'b', 'c', 'd', 'e', 'f', 'g');
    const attempt = async () => {
      throw locked();
    };
    await expect(withPassword('a.pdf', attempt, prompt)).rejects.toBeInstanceOf(PasswordGaveUp);
    expect(ask).toHaveBeenCalledTimes(PASSWORD_ATTEMPTS);
  });

  it('resolves null when the user cancels the prompt', async () => {
    const { prompt } = promptAnswering(null);
    const attempt = async () => {
      throw locked();
    };
    await expect(withPassword('a.pdf', attempt, prompt)).resolves.toBeNull();
  });

  it('passes any other error through without asking', async () => {
    const { prompt, ask } = promptAnswering();
    const refused = new RpcError('REFUSED', 'no');
    await expect(
      withPassword(
        'a.pdf',
        async () => {
          throw refused;
        },
        prompt,
      ),
    ).rejects.toBe(refused);
    expect(ask).not.toHaveBeenCalled();
  });
});
