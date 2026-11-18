import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import { MAX_FILE_BYTES, openFile } from './openFile';

const OPENED = { handle: 'doc-1', pages: 4, warning: null, info: {}, state: {} };

function pdf(name = 'report.pdf', content = '%PDF-1.4 body'): File {
  return new File([content], name, { type: 'application/pdf' });
}

// A client whose session.open answers from the script. Each call's params are recorded.
function scriptedClient(replies: (() => unknown)[]) {
  const calls: { method: string; params: { name: string; password: string | null } }[] = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params: params as (typeof calls)[number]['params'] });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('no scripted reply left');
    return reply();
  });
  return { client: { call } as unknown as EngineClient, call, calls };
}

const answer = (value: unknown) => () => value;
const fail = (code: ConstructorParameters<typeof RpcError>[0]) => () => {
  throw new RpcError(code, code.toLowerCase());
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openFile', () => {
  it('sends the name and the bytes through session.open and returns the reply', async () => {
    const { client, calls } = scriptedClient([answer(OPENED)]);
    const askPassword = vi.fn(async () => null);

    const outcome = await openFile(client, pdf('report.pdf'), askPassword);

    expect(outcome).toEqual({ status: 'opened', result: OPENED });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('session.open');
    expect(calls[0]!.params).toMatchObject({ name: 'report.pdf', password: null });
    expect(askPassword).not.toHaveBeenCalled();
  });

  it('reads the file for the call as an ArrayBuffer', async () => {
    const { client, call } = scriptedClient([answer(OPENED)]);
    await openFile(client, pdf('a.pdf', 'xyz'), async () => null);
    const params = call.mock.calls[0]![1] as { data: unknown };
    expect(params.data).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(params.data as ArrayBuffer)).toBe('xyz');
  });

  it('asks for the password once and opens again with it', async () => {
    const { client, calls } = scriptedClient([fail('PASSWORD_REQUIRED'), answer(OPENED)]);
    const askPassword = vi.fn(async () => 'secret');

    const outcome = await openFile(client, pdf('locked.pdf'), askPassword);

    expect(outcome).toEqual({ status: 'opened', result: OPENED });
    expect(askPassword).toHaveBeenCalledTimes(1);
    expect(askPassword).toHaveBeenCalledWith('locked.pdf');
    expect(calls.map((call) => call.params.password)).toEqual([null, 'secret']);
  });

  it('stops without a second call when the user cancels the password', async () => {
    const { client, calls } = scriptedClient([fail('PASSWORD_REQUIRED')]);
    const outcome = await openFile(client, pdf('locked.pdf'), async () => null);
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('reports a wrong password once, without asking again', async () => {
    const { client, calls } = scriptedClient([fail('PASSWORD_REQUIRED'), fail('WRONG_PASSWORD')]);
    const askPassword = vi.fn(async () => 'nope');

    const outcome = await openFile(client, pdf('locked.pdf'), askPassword);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.error.code).toBe('WRONG_PASSWORD');
    expect(askPassword).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('returns other engine errors without asking for a password', async () => {
    const { client } = scriptedClient([fail('OPEN_FAILED')]);
    const askPassword = vi.fn(async () => 'unused');
    const outcome = await openFile(client, pdf(), askPassword);
    expect(outcome.status === 'failed' && outcome.error.code).toBe('OPEN_FAILED');
    expect(askPassword).not.toHaveBeenCalled();
  });

  it('turns a failure that is not an RpcError into INTERNAL', async () => {
    const client = { call: vi.fn(async () => Promise.reject(new TypeError('boom'))) };
    const outcome = await openFile(client as unknown as EngineClient, pdf(), async () => null);
    expect(outcome.status === 'failed' && outcome.error.code).toBe('INTERNAL');
  });

  it('refuses a file above the engine limit without a call', async () => {
    const { client, call } = scriptedClient([]);
    const big = pdf('huge.pdf');
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });

    const outcome = await openFile(client, big, async () => null);

    expect(call).not.toHaveBeenCalled();
    expect(outcome.status === 'failed' && outcome.error.code).toBe('FILE_TOO_LARGE');
    expect(outcome.status === 'failed' && outcome.error.details).toEqual({
      max_bytes: MAX_FILE_BYTES,
      size: MAX_FILE_BYTES + 1,
    });
  });

  it('keeps the password out of localStorage and sessionStorage', async () => {
    const { client } = scriptedClient([fail('PASSWORD_REQUIRED'), answer(OPENED)]);
    await openFile(client, pdf('locked.pdf'), async () => 'hunter2-secret');
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index) ?? '';
        expect(key + (store.getItem(key) ?? '')).not.toContain('hunter2-secret');
      }
    }
  });
});
