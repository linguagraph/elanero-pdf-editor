// The redaction calls of W7.4: marks made, removed and undone through actions.run and actions.undo,
// and the apply as an action job (W1.2 section 13). Nothing here builds a mark or burns text: the
// actions layer does (W1.3), and the job applies what the engine returns.
import { type ActionJobDeps, runActionJob, type ActionJobOutcome } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { hexToColorJson, type ColorJson } from '../prefs/colour';
import { type Preferences, readPreferences } from '../prefs/store';
import type { ChangedDto, RedactionListResult } from '../rpc/generated';
import { expectArray, expectInteger, expectObject, expectString, field } from '../rpc/shape';
import {
  DEFAULT_REDACT_OPTIONS,
  markRefsJson,
  markStylePatchJson,
  type MarkRef,
  type MarkStylePatch,
  type RedactionAreaJson,
  redactionAreaJson,
} from './marks';
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

// Adds marks for the given areas: one undo step, and the reply names the marks it added. The author
// and the style are read from the preferences now, so a change applies to the next mark.
export async function addRedactionAreas(
  rpc: PageRpc,
  handle: string,
  areas: readonly RedactionAreaJson[],
): Promise<MarksResult> {
  const prefs = readPreferences();
  const reply = await rpc.call('actions.run', {
    handle,
    name: 'redaction.mark',
    args: {
      areas,
      author: prefs.authorName,
      style: redactionStyleJson(prefs),
    },
  });
  return { marks: reply.executed ? readMarkRefs(reply.value) : [], changed: reply.changed };
}

// Adds one mark for a box drawn on a page. One undo step; the reply names the mark it added.
export function addRedactionMark(
  rpc: PageRpc,
  handle: string,
  page: number,
  rect: PageRect,
): Promise<MarksResult> {
  return addRedactionAreas(rpc, handle, [redactionAreaJson(page, rect)]);
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

// Changes the style of the named marks: one undo step. The reply names the marks it changed.
export async function restyleRedactionMarks(
  rpc: PageRpc,
  handle: string,
  marks: readonly MarkRef[],
  patch: MarkStylePatch,
): Promise<ChangedDto | null> {
  const reply = await rpc.call('actions.run', {
    handle,
    name: 'redaction.restyle_marks',
    args: { marks: markRefsJson(marks), ...markStylePatchJson(patch) },
  });
  return reply.changed;
}

// The document's marks, as the engine lists them (every mark in the file, not this tab's only).
export function listRedactionMarks(rpc: PageRpc, handle: string): Promise<RedactionListResult> {
  return rpc.call('redaction.list', { handle });
}

// Burns the marks into the document: the text and the image pixels under them are removed, and
// the engine checks that nothing readable is left (the report). Runs as a mutating action job.
// Null applies every mark in the document, the ones from the file too (the desktop's Apply All).
export function applyRedactions(
  deps: ActionJobDeps,
  handle: string,
  marks: readonly MarkRef[] | null,
): Promise<ActionJobOutcome> {
  return runActionJob(deps, handle, 'redaction.apply', {
    marks: marks === null ? null : markRefsJson(marks),
    options: { ...DEFAULT_REDACT_OPTIONS },
  });
}
