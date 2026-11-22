import { EngineLoadError } from './errors';
import { needsFontTools, type CallResult, type LoadEngine, type WorkerRole } from './loader';
import type { DispatchMessage, ErrorMessage, NoticeMessage, ReplyMessage, Stage } from './protocol';
import { TRANSLATION_METHODS, type TranslationNet } from './translationNet';

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
  // The translation gate (W6.6). Armed for the duration of each translation call, and only then.
  translation?: TranslationNet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The methods whose pixels may travel as an ImageBitmap (W5.1b S5).
const RENDER_METHODS = new Set(['render.page', 'render.tile']);

function methodOf(request: string): unknown {
  try {
    const parsed: unknown = JSON.parse(request);
    return isRecord(parsed) ? parsed.method : undefined;
  } catch {
    return undefined;
  }
}

// Draws a render reply's RGBA pixels into an ImageBitmap, and rewrites the reply to name it. Returns
// undefined when the reply should stay an ArrayBuffer: not a render, no pixels (a stale revision),
// no createImageBitmap in this worker, or the browser refuses the bitmap. The alpha and colour
// options match the main thread's putImageData path, so the pixels are the same either way.
async function bitmapReply(
  request: string,
  result: CallResult,
): Promise<{ reply: string; bitmap: ImageBitmap } | undefined> {
  const { buffer } = result;
  if (buffer === undefined || result.buffers !== undefined) return undefined;
  if (!RENDER_METHODS.has(methodOf(request) as string)) return undefined;
  if (typeof createImageBitmap !== 'function' || typeof ImageData !== 'function') return undefined;
  try {
    const envelope = JSON.parse(result.reply) as unknown;
    if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.result)) return undefined;
    const page = envelope.result;
    const { width, height } = page;
    if (page.format !== 'rgba' || typeof width !== 'number' || typeof height !== 'number') {
      return undefined;
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return undefined;
    }
    if (buffer.byteLength !== width * height * 4) return undefined;
    if (JSON.stringify(page.pixels) !== '{"$bin":0}') return undefined;

    const image = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const bitmap = await createImageBitmap(image, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    page.format = 'bitmap';
    page.pixels = { $bin: 0 };
    return { reply: JSON.stringify(envelope), bitmap };
  } catch {
    return undefined;
  }
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
      const onNotice = (notice: Record<string, unknown>, buffer?: ArrayBuffer): void => {
        const noticeMessage: NoticeMessage = { kind: 'notice', id: message.id, notice, buffer };
        if (buffer === undefined) scope.postMessage(noticeMessage);
        else scope.postMessage(noticeMessage, [buffer]);
      };
      // The gate is armed only while this call runs (W6.6 section 3), and disarmed on a throw too.
      const net = options.translation;
      const gated =
        net !== undefined && TRANSLATION_METHODS.has(methodOf(message.request) as string);
      if (gated) net.arm();
      let result: CallResult;
      try {
        result = handle.dispatch(message.request, message.buffers ?? [], onNotice);
      } finally {
        if (gated) net.disarm();
      }
      const drawn = await bitmapReply(message.request, result);
      if (drawn !== undefined) {
        // The bitmap is transferred; the reply's buffer is empty and only satisfies the $bin marker.
        const bitmapMessage: ReplyMessage = {
          id: message.id,
          reply: drawn.reply,
          buffer: new ArrayBuffer(0),
          bitmap: drawn.bitmap,
        };
        scope.postMessage(bitmapMessage, [drawn.bitmap]);
        return;
      }
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
          translationNet: options.translation,
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
