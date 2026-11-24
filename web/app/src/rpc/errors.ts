// Maps an engine failure to what the UI shows: a message id, its parameters and the action to
// offer (W1.2 section 4, W1.1 sections 1 and 4). The text comes from the catalogue, so this file
// holds no user-facing English. An unknown code gets the generic message and no details.
import type { FailedStage } from '../engine/protocol';
import type { MessageId } from '../i18n/en';
import { formatMegabytes, formatNumber } from '../i18n/format';
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

type Details = Readonly<Record<string, unknown>>;

// A variant chosen from the reply's details: the message with its parameters.
interface Variant {
  messageId: MessageId;
  params: Params;
}

interface Entry {
  messageId: MessageId;
  action: RecommendedAction;
  silent?: boolean;
  // Picks a variant from the details (a limit, or a REFUSED reason). Undefined means the details
  // don't say enough, and the plain message is used.
  fromDetails?: (details: Details) => Variant | undefined;
}

// details.max_bytes (W1.2 section 4), formatted for the locale, e.g. "50 MB".
function fileLimit(details: Details): Variant | undefined {
  const maxBytes = details['max_bytes'];
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) return undefined;
  return { messageId: 'error.FILE_TOO_LARGE.limit', params: { limit: formatMegabytes(maxBytes) } };
}

// details.max_pages (webapi/session.py) as a count, e.g. "5,000".
function pageLimit(details: Details): Variant | undefined {
  const maxPages = details['max_pages'];
  if (typeof maxPages !== 'number' || !Number.isFinite(maxPages) || maxPages <= 0) return undefined;
  return { messageId: 'error.TOO_MANY_PAGES.limit', params: { limit: formatNumber(maxPages) } };
}

// The known reasons of a REFUSED reply (details.reason, set in webapi/jobs.py and save.py). An
// unknown reason, including any free text, keeps the plain message: the reason text is never shown.
export const REFUSED_REASON: Readonly<Record<string, MessageId>> = {
  encrypted_source: 'error.REFUSED.encryptedSource',
  encrypted_mutating_job: 'job.encryptedRefused',
  encrypted_reduce: 'error.REFUSED.encryptedReduce',
  'document changed': 'error.REFUSED.documentChanged',
  crop_too_large: 'error.REFUSED.cropTooLarge',
  invalid_margins: 'error.REFUSED.invalidMargins',
  invalid_pages: 'error.REFUSED.invalidPages',
  outline_too_deep: 'error.REFUSED.outlineTooDeep',
  // The image refusals of content.add_image (W6.7b slice 2a): worded here, since the engine's own
  // text is never shown.
  image_unreadable: 'error.REFUSED.imageUnreadable',
  image_format: 'error.REFUSED.imageFormat',
  image_too_large: 'error.REFUSED.imageTooLarge',
  image_too_many_pixels: 'error.REFUSED.imageTooManyPixels',
  // Replace and Export of a picture stored in the page content (W6.7b slice 2b).
  inline_image: 'error.REFUSED.inlineImage',
  // The shape style refusals (W6.7b slice 3a): no outline and no fill, or a width out of range.
  shape_no_paint: 'error.REFUSED.shapeNoPaint',
  shape_width: 'error.REFUSED.shapeWidth',
  // The attachment refusals of attachments.add (W7.9 A1). A signed document has its own reason.
  attachment_empty: 'error.REFUSED.attachmentEmpty',
  attachment_too_large: 'error.REFUSED.attachmentTooLarge',
  attachment_name: 'error.REFUSED.attachmentName',
  signed_document: 'error.REFUSED.signedDocument',
};

function refusedReason(details: Details): Variant | undefined {
  const reason = details['reason'];
  if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(REFUSED_REASON, reason)) {
    return undefined;
  }
  const messageId = REFUSED_REASON[reason];
  return messageId === undefined ? undefined : { messageId, params: {} };
}

// One entry per code. The Record type makes a new code in the generated union a compile error
// here, and the tests check each entry against the catalogue.
export const TABLE: Record<RpcErrorCode, Entry> = {
  INVALID_REQUEST: { messageId: 'error.INVALID_REQUEST', action: 'reload page' },
  INVALID_ARGS: { messageId: 'error.INVALID_ARGS', action: 'reload page' },
  INVALID_FONT: { messageId: 'error.INVALID_FONT', action: 'dismiss' },
  FONT_NOT_EMBEDDABLE: { messageId: 'error.FONT_NOT_EMBEDDABLE', action: 'dismiss' },
  FONT_STORAGE_FULL: { messageId: 'error.FONT_STORAGE_FULL', action: 'dismiss' },
  PROTOCOL_MISMATCH: { messageId: 'error.PROTOCOL_MISMATCH', action: 'reload page' },
  NO_DOCUMENT: { messageId: 'error.NO_DOCUMENT', action: 'close document' },
  PASSWORD_REQUIRED: { messageId: 'error.PASSWORD_REQUIRED', action: 'ask for password' },
  WRONG_PASSWORD: { messageId: 'error.WRONG_PASSWORD', action: 'ask for password' },
  OPEN_FAILED: { messageId: 'error.OPEN_FAILED', action: 'dismiss' },
  SAVE_FAILED: { messageId: 'error.SAVE_FAILED', action: 'retry' },
  REFUSED: { messageId: 'error.REFUSED', action: 'dismiss', fromDetails: refusedReason },
  BUSY: { messageId: 'error.BUSY', action: 'wait' },
  NOT_SUPPORTED: { messageId: 'error.NOT_SUPPORTED', action: 'dismiss' },
  STALE_OBJECT: { messageId: 'error.STALE_OBJECT', action: 'retry' },
  STALE_CURSOR: { messageId: 'error.STALE_CURSOR', action: 'retry' },
  STALE_JOB: { messageId: 'error.STALE_JOB', action: 'dismiss' },
  CANCELLED: { messageId: 'error.CANCELLED', action: 'dismiss', silent: true },
  FILE_TOO_LARGE: {
    messageId: 'error.FILE_TOO_LARGE',
    action: 'dismiss',
    fromDetails: fileLimit,
  },
  TOO_MANY_PAGES: {
    messageId: 'error.TOO_MANY_PAGES',
    action: 'dismiss',
    fromDetails: pageLimit,
  },
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
  const variant = entry.fromDetails?.(error.details);
  if (variant !== undefined) {
    return { ...variant, action: entry.action, silent: false };
  }
  return {
    messageId: entry.messageId,
    params: {},
    action: entry.action,
    silent: entry.silent === true,
  };
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
