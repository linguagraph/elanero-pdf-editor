import { EngineLoadError } from './errors';
import { needsFontTools, type LoadEngine, type WorkerRole } from './loader';
import type { DispatchMessage, ErrorMessage, ReplyMessage, Stage } from './protocol';

// The slice of a dedicated worker's global scope that the server uses.
export interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface ServeOptions {
  load: LoadEngine;
  beforeEngine?: () => void;
  // The Python entry point this worker answers with (the job worker's is 'job').
  role?: WorkerRole;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describeError(error: unknown): ErrorMessage['error'] {
  if (error instanceof EngineLoadError) return { message: error.message, stage: error.stage };
  return { message: error instanceof Error ? error.message : String(error) };
}

// Answers the 'dispatch' method for one worker. The first 'init' message starts the load once;
// calls wait for the engine, and fail with the load's stage if it did not come up.
export function serveEngine(scope: WorkerScope, options: ServeOptions): void {
  let engine: ReturnType<LoadEngine> | undefined;

  const reportStage = (stage: Stage): void => {
    scope.postMessage({ kind: 'stage', stage });
  };

  const answer = async (message: DispatchMessage): Promise<void> => {
    try {
      if (engine === undefined) throw new Error('the engine has not been started');
      const handle = await engine;
      // A text edit runs after fontTools is in place (W6.8a), so the first one waits for the install.
      if (needsFontTools(message.request)) await handle.ensureFontTools?.();
      // A notice of this call (a job's progress) goes out before the reply, with the call's id.
      const onNotice = (notice: Record<string, unknown>): void => {
        scope.postMessage({ kind: 'notice', id: message.id, notice });
      };
      const result = handle.dispatch(message.request, message.buffers ?? [], onNotice);
      const reply: ReplyMessage = { id: message.id, reply: result.reply };
      if (result.buffers !== undefined) {
        reply.buffers = result.buffers;
        scope.postMessage(reply, result.buffers);
      } else if (result.buffer === undefined) {
        scope.postMessage(reply);
      } else {
        reply.buffer = result.buffer;
        scope.postMessage(reply, [result.buffer]);
      }
    } catch (error) {
      const failure: ErrorMessage = { id: message.id, error: describeError(error) };
      scope.postMessage(failure);
    }
  };

  scope.addEventListener('message', (event) => {
    const data = event.data;
    if (!isRecord(data)) return;

    if (data.kind === 'init') {
      if (engine === undefined && typeof data.baseUrl === 'string') {
        engine = options.load({
          baseUrl: data.baseUrl,
          onStage: reportStage,
          beforeEngine: options.beforeEngine,
          role: options.role,
        });
        // A failed load is reported by each call, so this handler must not leave it unhandled.
        engine.catch(() => undefined);
      }
      return;
    }

    if (typeof data.id !== 'number') return;
    if (data.method !== 'dispatch' || typeof data.request !== 'string') {
      const failure: ErrorMessage = {
        id: data.id,
        error: { message: 'unknown or malformed request' },
      };
      scope.postMessage(failure);
      return;
    }
    void answer(data as unknown as DispatchMessage);
  });
}

// True inside a dedicated worker, so an entry module can start itself. Tests import the entry
// modules too, and there this is false.
export function isWorkerContext(): boolean {
  return (
    typeof (globalThis as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !==
    'undefined'
  );
}
