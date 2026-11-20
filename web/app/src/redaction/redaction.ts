// The redaction calls of W7.4: marks made, removed and undone through actions.run and actions.undo,
// and the apply as an action job (W1.2 section 13). Nothing here builds a mark or burns text: the
// actions layer does (W1.3), and the job applies what the engine returns.
import { type ActionJobDeps, runActionJob, type ActionJobOutcome } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { hexToColorJson, type ColorJson } from '../prefs/colour';
import { type Preferences, readPreferences } from '../prefs/store';
import type { ChangedDto } from '../rpc/generated';
import { expectArray, expectInteger, expectObject, expectString, field } from '../rpc/shape';
import { DEFAULT_REDACT_OPTIONS, markRefsJson, type MarkRef, redactionAreaJson } from './marks';
import type { PageRect } from '../comments/coordinates';

export interface MarksResult {
  readonly marks: readonly MarkRef[];
  readonly changed: ChangedDto | null;
}

// The marks named in an action's value: a list of {page, name} (W1.3 MarkRef).
export function readMarkRefs(value: unknown): MarkRef[] {
  return expectArray(value, 'value').map((item, index) => {
    const entry = expectObject(item, `value[${index}]`);
    return {
      page: expectInteger(field(entry, 'page', `value[${index}]`), `value[${index}].page`),
      name: expectString(field(entry, 'name', `value[${index}]`), `value[${index}].name`),
    };
  });
}

// The mark style the engine takes (MarkStyle in services/redaction.py). The colours are {r,g,b} in
// 0..1; alpha is left to the engine's default of 1.
export interface RedactionStyleJson {
  readonly fill: ColorJson;
  readonly overlay_text: string;
  readonly text_color: ColorJson;
}

export function redactionStyleJson(
  prefs: Pick<Preferences, 'redactionFill' | 'redactionOverlayText' | 'redactionTextColor'>,
): RedactionStyleJson {
  return {
    fill: hexToColorJson(prefs.redactionFill),
    overlay_text: prefs.redactionOverlayText,
    text_color: hexToColorJson(prefs.redactionTextColor),
  };
}

// Adds one mark for a box drawn on a page. One undo step; the reply names the mark it added. The
// author and the style are read from the preferences now, so a change applies to the next mark.
export async function addRedactionMark(
  rpc: PageRpc,
  handle: string,
  page: number,
  rect: PageRect,
): Promise<MarksResult> {
  const prefs = readPreferences();
  const reply = await rpc.call('actions.run', {
    handle,
    name: 'redaction.mark',
    args: {
      areas: [redactionAreaJson(page, rect)],
      author: prefs.authorName,
      style: redactionStyleJson(prefs),
    },
  });
  return { marks: reply.executed ? readMarkRefs(reply.value) : [], changed: reply.changed };
}

// Deletes the named marks. The step is undoable like any other.
export async function removeRedactionMarks(
  rpc: PageRpc,
  handle: string,
  marks: readonly MarkRef[],
): Promise<ChangedDto | null> {
  const reply = await rpc.call('actions.run', {
    handle,
    name: 'redaction.remove_marks',
    args: { marks: markRefsJson(marks) },
  });
  return reply.changed;
}

// Burns the marks into the document: the text and the image pixels under them are removed, and
// the engine checks that nothing readable is left (the report). Runs as a mutating action job.
export function applyRedactions(
  deps: ActionJobDeps,
  handle: string,
  marks: readonly MarkRef[],
): Promise<ActionJobOutcome> {
  return runActionJob(deps, handle, 'redaction.apply', {
    marks: markRefsJson(marks),
    options: { ...DEFAULT_REDACT_OPTIONS },
  });
}

// Reverses the last step, as the toast's Undo does.
export async function undoLastStep(rpc: PageRpc, handle: string): Promise<ChangedDto | null> {
  const reply = await rpc.call('actions.undo', { handle, expect_history: null });
  return reply.done ? reply.changed : null;
}
