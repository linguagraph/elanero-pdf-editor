// The flatten call of W7.9 (W1.5 section 9): annotations.flatten with every comment, run as a
// mutating action job (W1.2 section 13). Nothing here draws a comment into the page: the actions
// layer does (W1.3), and the job applies what the engine returns.
import { type ActionJobDeps, type ActionJobOutcome, runActionJob } from '../actionJob/actionJob';

export const FLATTEN_ACTION = 'annotations.flatten';

// refs null burns every comment in the document, as the desktop's Flatten All Comments does.
export function flattenArgs(): { refs: null } {
  return { refs: null };
}

// Flattens every comment as one undoable step. Resolves with the outcome; rejects with an RpcError
// or ActionJobCancelled, as the job runner does.
export function runFlatten(deps: ActionJobDeps, handle: string): Promise<ActionJobOutcome> {
  return runActionJob(deps, handle, FLATTEN_ACTION, flattenArgs());
}
