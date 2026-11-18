// A stand-in for the engine connection, for tests of the app shell and the document flows. It
// holds the client the test gives it (none means the engine is not ready) and records the start
// and dispose calls. Only tests import it; the app never does.
import { vi, type Mock } from 'vitest';
import { createEngineLoadStore, type EngineLoadStore } from '../feedback/engineLoad';
import type { EngineClient, EngineConnection } from './engineConnection';

export interface FakeEngine extends EngineConnection {
  readonly store: EngineLoadStore;
  readonly start: Mock<() => void>;
  readonly dispose: Mock<() => void>;
  setClient(client: EngineClient | undefined): void;
}

export function fakeEngine(client?: EngineClient): FakeEngine {
  let current = client;
  return {
    store: createEngineLoadStore(),
    client: () => current,
    start: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
    setClient(next) {
      current = next;
    },
  };
}
