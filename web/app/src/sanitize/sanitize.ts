// The sanitize calls of W7.4: the options the dialog offers, the job's arguments and its result.
// The names are SanitizeOptions in model/redaction.py, sent unchanged; the removing is the actions
// layer's (document.sanitize, W1.3), run as a mutating action job.
import { type ActionJobDeps, runActionJob } from '../actionJob/actionJob';
import type { MessageId } from '../i18n/en';
import type { ChangedDto } from '../rpc/generated';
import { expectArray, expectString } from '../rpc/shape';

export const SANITIZE_OPTIONS = [
  'metadata',
  'xmp',
  'javascript',
  'attachments',
  'links',
  'hidden_text',
  'comments',
  'form_data',
  'thumbnails',
  'hidden_layers',
  'off_page_text',
] as const;

export type SanitizeOption = (typeof SANITIZE_OPTIONS)[number];
export type SanitizeChoice = Readonly<Record<SanitizeOption, boolean>>;

// Every option starts on, as SanitizeOptions does on the desktop.
export const SANITIZE_DEFAULTS: SanitizeChoice = Object.fromEntries(
  SANITIZE_OPTIONS.map((option) => [option, true]),
) as SanitizeChoice;

export const SANITIZE_LABEL: Readonly<Record<SanitizeOption, MessageId>> = {
  metadata: 'sanitize.option.metadata',
  xmp: 'sanitize.option.xmp',
  javascript: 'sanitize.option.javascript',
  attachments: 'sanitize.option.attachments',
  links: 'sanitize.option.links',
  hidden_text: 'sanitize.option.hidden_text',
  comments: 'sanitize.option.comments',
  form_data: 'sanitize.option.form_data',
  thumbnails: 'sanitize.option.thumbnails',
  hidden_layers: 'sanitize.option.hidden_layers',
  off_page_text: 'sanitize.option.off_page_text',
};

// The job's arguments: every option is sent, so the job never relies on a default the browser
// does not know about.
export function sanitizeArgs(choice: SanitizeChoice): { options: Record<SanitizeOption, boolean> } {
  return {
    options: Object.fromEntries(SANITIZE_OPTIONS.map((o) => [o, choice[o]])) as Record<
      SanitizeOption,
      boolean
    >,
  };
}

// The items the action removed, as its value lists them (W1.3 ActionResult.value).
export function readRemoved(value: unknown): string[] {
  return expectArray(value, 'value').map((item, index) => expectString(item, `value[${index}]`));
}

// Runs the sanitize as a mutating job. Resolves with what was removed.
export async function runSanitize(
  deps: ActionJobDeps,
  handle: string,
  choice: SanitizeChoice,
): Promise<{ removed: string[]; changed: ChangedDto | null }> {
  const outcome = await runActionJob(deps, handle, 'document.sanitize', sanitizeArgs(choice));
  return { removed: readRemoved(outcome.value), changed: outcome.changed };
}
