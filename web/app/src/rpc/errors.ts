// Maps an engine failure to what the UI shows: a message id, its parameters and the action to
// offer (W1.2 section 4, W1.1 sections 1 and 4). The text comes from the catalogue, so this file
// holds no user-facing English. An unknown code gets the generic message and no details.
import type { FailedStage } from '../engine/protocol';
import type { MessageId } from '../i18n/en';
import type { Params } from '../i18n/t';
import type { RpcError, RpcErrorCode } from './client';

// What the user can do next. The button labels come from the catalogue (`action.*`).
export type RecommendedAction =
  | 'retry'
  | 'dismiss'
  | 'wait'
  | 'restart engine'
  | 'ask for password'
  | 'save as a new file'
  | 'reload page'
  | 'close document';

export interface ErrorPresentation {
  messageId: MessageId;
  params: Params;
  action: RecommendedAction;
  // True for a failure the user asked for (a cancel): the UI shows nothing.
  silent: boolean;
}

// What the caller knows about the failed operation. Only SAVE_FAILED depends on it: after an
// in-place save of a signed document, a retry in place is the wrong advice (W1.1 section 4).
export interface ErrorContext {
  signedInPlaceSave?: boolean;
}

interface Entry {
  messageId: MessageId;
  action: RecommendedAction;
  silent?: boolean;
  // Reads the numbers the message shows from the reply's details. Returns undefined when they
  // are missing, and the entry's plain message is used.
  limit?: (details: Readonly<Record<string, unknown>>) => string | undefined;
}

const MEBIBYTE = 1024 * 1024;

// details.max_bytes (W1.2 section 4) as a size, e.g. "50 MB" or "2.5 MB".
function fileLimit(details: Readonly<Record<string, unknown>>): string | undefined {
  const maxBytes = details['max_bytes'];
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) return undefined;
  return `${Math.round((maxBytes / MEBIBYTE) * 10) / 10} MB`;
}

// One entry per code. The Record type makes a new code in the generated union a compile error
// here, and the tests check each entry against the catalogue.
const TABLE: Record<RpcErrorCode, Entry> = {
  INVALID_REQUEST: { messageId: 'error.INVALID_REQUEST', action: 'reload page' },
  INVALID_ARGS: { messageId: 'error.INVALID_ARGS', action: 'reload page' },
  INVALID_FONT: { messageId: 'error.INVALID_FONT', action: 'dismiss' },
  FONT_NOT_EMBEDDABLE: { messageId: 'error.FONT_NOT_EMBEDDABLE', action: 'dismiss' },
  PROTOCOL_MISMATCH: { messageId: 'error.PROTOCOL_MISMATCH', action: 'reload page' },
  NO_DOCUMENT: { messageId: 'error.NO_DOCUMENT', action: 'close document' },
  PASSWORD_REQUIRED: { messageId: 'error.PASSWORD_REQUIRED', action: 'ask for password' },
  WRONG_PASSWORD: { messageId: 'error.WRONG_PASSWORD', action: 'ask for password' },
  OPEN_FAILED: { messageId: 'error.OPEN_FAILED', action: 'dismiss' },
  SAVE_FAILED: { messageId: 'error.SAVE_FAILED', action: 'retry' },
  REFUSED: { messageId: 'error.REFUSED', action: 'dismiss' },
  BUSY: { messageId: 'error.BUSY', action: 'wait' },
  NOT_SUPPORTED: { messageId: 'error.NOT_SUPPORTED', action: 'dismiss' },
  STALE_OBJECT: { messageId: 'error.STALE_OBJECT', action: 'retry' },
  STALE_CURSOR: { messageId: 'error.STALE_CURSOR', action: 'retry' },
  STALE_JOB: { messageId: 'error.STALE_JOB', action: 'dismiss' },
  CANCELLED: { messageId: 'error.CANCELLED', action: 'dismiss', silent: true },
  FILE_TOO_LARGE: { messageId: 'error.FILE_TOO_LARGE', action: 'dismiss', limit: fileLimit },
  TOO_MANY_PAGES: { messageId: 'error.TOO_MANY_PAGES', action: 'dismiss' },
  RENDER_TOO_LARGE: { messageId: 'error.RENDER_TOO_LARGE', action: 'dismiss' },
  IMAGE_TOO_LARGE: { messageId: 'error.IMAGE_TOO_LARGE', action: 'dismiss' },
  OUT_OF_MEMORY: { messageId: 'error.OUT_OF_MEMORY', action: 'restart engine' },
  ENGINE_ERROR: { messageId: 'error.ENGINE_ERROR', action: 'retry' },
  TRANSLATION_OFFLINE: { messageId: 'error.TRANSLATION_OFFLINE', action: 'retry' },
  TRANSLATION_QUOTA: { messageId: 'error.TRANSLATION_QUOTA', action: 'dismiss' },
  TRANSLATION_AUTH: { messageId: 'error.TRANSLATION_AUTH', action: 'dismiss' },
  TRANSLATION_CONFIG: { messageId: 'error.TRANSLATION_CONFIG', action: 'dismiss' },
  TRANSLATION_TOO_LONG: { messageId: 'error.TRANSLATION_TOO_LONG', action: 'dismiss' },
  TRANSLATION_SAME_LANGUAGE: { messageId: 'error.TRANSLATION_SAME_LANGUAGE', action: 'dismiss' },
  TRANSLATION_SERVICE: { messageId: 'error.TRANSLATION_SERVICE', action: 'retry' },
  INTERNAL: { messageId: 'error.INTERNAL', action: 'retry' },
  TIMEOUT: { messageId: 'error.TIMEOUT', action: 'restart engine' },
};

const GENERIC: Entry = { messageId: 'error.UNKNOWN', action: 'retry' };

// Maps a failure to its presentation. Details are read only where an entry names them, and the
// failure's own message is never shown: an unknown code gets the generic text.
export function mapRpcError(error: RpcError, context: ErrorContext = {}): ErrorPresentation {
  if (error.code === 'SAVE_FAILED' && context.signedInPlaceSave === true) {
    return {
      messageId: 'error.SAVE_FAILED.signed',
      params: {},
      action: 'save as a new file',
      silent: false,
    };
  }

  const known = Object.prototype.hasOwnProperty.call(TABLE, error.code);
  const entry: Entry = known ? TABLE[error.code as RpcErrorCode] : GENERIC;
  const limit = entry.limit?.(error.details);
  if (limit !== undefined) {
    return {
      messageId: entry.messageId,
      params: { limit },
      action: entry.action,
      silent: false,
    };
  }
  // A size error whose limit is unknown uses the plain sentence (no {limit} placeholder).
  const messageId: MessageId =
    entry.limit !== undefined ? 'error.FILE_TOO_LARGE.noLimit' : entry.messageId;
  return { messageId, params: {}, action: entry.action, silent: entry.silent === true };
}

// The catalogue key of each load stage's failure message (W3.1).
const LOAD_FAILURE: Record<FailedStage, MessageId> = {
  pyodide: 'loading.failed.pyodide',
  packages: 'loading.failed.packages',
  engine: 'loading.failed.engine',
};

// The message for a failed engine load, by the stage that failed.
export function mapLoadFailure(stage: FailedStage): ErrorPresentation {
  return { messageId: LOAD_FAILURE[stage], params: {}, action: 'retry', silent: false };
}

// The button label of each recommended action, from the catalogue.
const ACTION_LABEL: Record<RecommendedAction, MessageId> = {
  retry: 'action.retry',
  dismiss: 'action.dismiss',
  wait: 'action.wait',
  'restart engine': 'action.restartEngine',
  'ask for password': 'action.askPassword',
  'save as a new file': 'action.saveAsNew',
  'reload page': 'action.reloadPage',
  'close document': 'action.closeDocument',
};

export function actionLabelId(action: RecommendedAction): MessageId {
  return ACTION_LABEL[action];
}
