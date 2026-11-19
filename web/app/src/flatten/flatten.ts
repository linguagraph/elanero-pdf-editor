// The flatten calls of W7.9 (W1.5 section 9): the comment count, then annotations.flatten with every
// comment, run as a mutating action job (W1.2 section 13). Nothing here draws a comment into the
// page: the actions layer does (W1.3), and the job applies what the engine returns.
import { type ActionJobDeps, type ActionJobOutcome, runActionJob } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';

export const FLATTEN_ACTION = 'annotations.flatten';

// refs null burns every comment in the document, as the desktop's Flatten All Comments does.
export function flattenArgs(): { refs: null } {
  return { refs: null };
}

// How many comments Flatten would burn in. Read before the job, so a document with none gets a
// message and no job, no undo step and no redraw.
export async function countFlattenable(rpc: PageRpc, handle: string): Promise<number> {
  const reply = await rpc.call('comments.flattenable', { handle });
  return reply.count;
}

// Flattens every comment as one undoable step. Resolves with the outcome; rejects with an RpcError
// or ActionJobCancelled, as the job runner does.
export function runFlatten(deps: ActionJobDeps, handle: string): Promise<ActionJobOutcome> {
  return runActionJob(deps, handle, FLATTEN_ACTION, flattenArgs());
}
