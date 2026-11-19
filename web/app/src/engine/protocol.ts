// Messages between the main thread and the engine and job workers. Keep both sides in step.

export type Stage = 'pyodide' | 'packages' | 'engine' | 'ready';
export type FailedStage = Exclude<Stage, 'ready'>;

// main -> worker, first message: where the same-origin assets (pyodide.mjs, wheels, zip) live.
export interface InitMessage {
  kind: 'init';
  baseUrl: string;
}

// main -> worker: one request. The request is the JSON envelope; buffers carries its binary values,
// in the order its $bin markers name them (W1.2 section 5).
export interface DispatchMessage {
  id: number;
  method: 'dispatch';
  request: string;
  buffers?: ArrayBuffer[];
}

// worker -> main: a load step has started (or, for 'ready', finished).
export interface StageMessage {
  kind: 'stage';
  stage: Stage;
}

// worker -> main: the answer to one request.
export interface ReplyMessage {
  id: number;
  reply: string;
  buffer?: ArrayBuffer;
}

export interface ErrorMessage {
  id: number;
  error: { message: string; stage?: FailedStage };
}

export type WorkerOutbound = StageMessage | ReplyMessage | ErrorMessage;
