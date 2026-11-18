import type { FailedStage } from './protocol';

// A load failure, with the stage that failed. The UI shows this; it never sees a raw exception.
export class EngineLoadError extends Error {
  readonly stage: FailedStage;

  constructor(stage: FailedStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineLoadError';
    this.stage = stage;
  }
}

// A call that the worker answered with an error, or that never got an answer.
export class CallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallError';
  }
}
