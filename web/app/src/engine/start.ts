// Main-thread side of the workers. It holds no PDF logic: it creates a worker, relays requests
// and replies, and forwards stage events. Nothing here starts a worker at import time.
import { CallError, EngineLoadError } from './errors';
import type { CallResult } from './loader';
import type { ErrorMessage, ReplyMessage, Stage, WorkerOutbound } from './protocol';
import type { Notice } from './loader';

export interface StartOptions {
  // Absolute or same-origin URL of the worker module (engine.worker.ts or jobworker.ts, built).
  workerUrl: string;
  // Same-origin folder holding pyodide.mjs, the PyMuPDF wheel and pdfeditor-web.zip.
  assetBaseUrl: string;
}

export interface WorkerClient {
  // onNotice gets each notice of this call (a job's progress), in order, before the reply.
  call(
    request: string,
    buffers?: readonly ArrayBuffer[],
    onNotice?: (notice: Notice) => void,
  ): Promise<CallResult>;
  onStage(listener: (stage: Stage) => void): () => void;
  terminate(): void;
}

export function startEngine(options: StartOptions): WorkerClient {
  return startWorker(options);
}

// Starts the job worker. The app calls this only when a job is requested, never at startup.
export function startJobWorker(options: StartOptions): WorkerClient {
  return startWorker(options);
}

// The same origin as the page, so the page's CSP governs the worker (W1.1 section 10).
function sameOrigin(url: string): string {
  const resolved = new URL(url, globalThis.location.href);
  if (resolved.origin !== globalThis.location.origin) {
    throw new Error(`${url} is not on this origin`);
  }
  return resolved.href;
}

// The page's CSP requires Trusted Types for scripts (csp.ts), so a worker URL must be a
// TrustedScriptURL. The policy accepts only the blob: URL made above and nothing else. Without
// Trusted Types (jsdom, older browsers) the plain string is used.
let workerUrlPolicy: { createScriptURL(input: string): unknown } | undefined;

// The Worker constructor takes the TrustedScriptURL that this returns. TypeScript's DOM types do
// not declare that type, so the object is typed as the string it stands for.
function workerScriptUrl(url: string): string {
  const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (factory === undefined) return url;
  workerUrlPolicy ??= factory.createPolicy('elanero-worker-url', {
    createScriptURL(input: string) {
      if (!input.startsWith('blob:')) throw new TypeError('the worker URL is not a blob URL');
      return input;
    },
  });
  return workerUrlPolicy.createScriptURL(url) as unknown as string;
}

interface TrustedTypesFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL(input: string): string },
  ): { createScriptURL(input: string): unknown };
}

function toError(error: ErrorMessage['error']): Error {
  return error.stage === undefined
    ? new CallError(error.message)
    : new EngineLoadError(error.stage, error.message);
}

interface Waiter {
  resolve(result: CallResult): void;
  reject(error: Error): void;
  onNotice?: (notice: Notice) => void;
}

function startWorker(options: StartOptions): WorkerClient {
  const workerUrl = sameOrigin(options.workerUrl);
  const assetBase = sameOrigin(options.assetBaseUrl);

  // A blob URL whose only body is an import of the same-origin module. A worker made from a
  // blob: URL takes its creator's CSP, so the page policy applies inside it.
  const blobUrl = URL.createObjectURL(
    new Blob([`import "${workerUrl}";`], { type: 'text/javascript' }),
  );
  const worker = new Worker(workerScriptUrl(blobUrl), { type: 'module' });

  let blobRevoked = false;
  const revokeBlob = (): void => {
    if (blobRevoked) return;
    blobRevoked = true;
    URL.revokeObjectURL(blobUrl);
  };

  const pending = new Map<number, Waiter>();
  const stageListeners = new Set<(stage: Stage) => void>();
  let nextId = 1;
  let closed = false;

  const failAll = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  worker.addEventListener('message', (event: MessageEvent<WorkerOutbound>) => {
    // The first message means the module has loaded, so the blob is no longer needed.
    revokeBlob();
    const data = event.data;
    if ('kind' in data && data.kind === 'notice') {
      // A notice belongs to a call still waiting; one for a finished call is dropped.
      pending.get(data.id)?.onNotice?.(data.notice);
      return;
    }
    if ('kind' in data) {
      for (const listener of stageListeners) listener(data.stage);
      return;
    }
    const waiter = pending.get(data.id);
    if (waiter === undefined) return;
    pending.delete(data.id);
    if ('error' in data) {
      waiter.reject(toError(data.error));
    } else {
      const reply = data as ReplyMessage;
      if (reply.buffers !== undefined) {
        const [first] = reply.buffers;
        waiter.resolve({
          reply: reply.reply,
          buffers: reply.buffers,
          ...(first === undefined ? {} : { buffer: first }),
        });
      } else {
        waiter.resolve(
          reply.buffer === undefined
            ? { reply: reply.reply }
            : { reply: reply.reply, buffer: reply.buffer },
        );
      }
    }
  });

  worker.addEventListener('error', (event: ErrorEvent) => {
    failAll(new CallError(`the worker failed: ${event.message || 'unknown error'}`));
  });

  worker.addEventListener('messageerror', () => {
    failAll(new CallError('the worker sent a message that could not be read'));
  });

  worker.postMessage({ kind: 'init', baseUrl: assetBase });

  return {
    call(request, buffers = [], onNotice) {
      if (closed) return Promise.reject(new CallError('the worker has been terminated'));
      const id = nextId++;
      return new Promise<CallResult>((resolve, reject) => {
        pending.set(id, { resolve, reject, onNotice });
        const message = { id, method: 'dispatch', request };
        try {
          if (buffers.length === 0) {
            worker.postMessage(message);
          } else {
            // Each buffer is transferred, so the caller's copies are detached.
            worker.postMessage({ ...message, buffers: [...buffers] }, [...buffers]);
          }
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new CallError(String(error)));
        }
      });
    },

    onStage(listener) {
      stageListeners.add(listener);
      return () => {
        stageListeners.delete(listener);
      };
    },

    terminate() {
      if (closed) return;
      closed = true;
      worker.terminate();
      revokeBlob();
      failAll(new CallError('the worker has been terminated'));
      stageListeners.clear();
    },
  };
}
