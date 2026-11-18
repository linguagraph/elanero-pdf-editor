import { describe, expect, it } from 'vitest';
import { type EngineSession, getTabSession, setTabSession } from './engineConnection';

const session: EngineSession = {
  rpc: { call: () => Promise.reject(new Error('not used')) } as unknown as EngineSession['rpc'],
  handle: 'doc-1',
};

describe('tab engine sessions', () => {
  it('gives no session to a tab until one is set', () => {
    expect(getTabSession(101)).toBeNull();
  });

  it('keeps the session per tab and forgets it when cleared', () => {
    setTabSession(101, session);
    expect(getTabSession(101)).toBe(session);
    expect(getTabSession(102)).toBeNull();
    setTabSession(101, null);
    expect(getTabSession(101)).toBeNull();
  });
});
