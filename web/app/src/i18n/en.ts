// The English message catalogue: the only source of user-facing text for the web app (W1.6 section
// 11, W4.7). Keys are stable ids, `area.item`; the error keys are `error.<CODE>` with the codes of
// the generated ErrorCode union (W1.2 section 4), which a test checks.
//
// Values are plain text, never HTML: the UI renders them as text nodes, so no escaping is needed
// and none is done. `{name}` marks a named parameter that `t()` fills in from its second argument.
// Messages say what happened and what to do, in words the user knows; they never name internal
// classes or error codes.
export const EN = {
  // App shell and About.
  'app.name': 'Elanero',
  'app.version': 'Version {version}',
  'about.title': 'About Elanero',
  'about.licence': 'Licence: AGPL-3.0-or-later',
  'about.source': 'Source code',

  // Layout regions (W1.6 sections 1 and 12) and panel frames (section 4).
  'layout.leftRail': 'Left rail',
  'layout.leftPanel': 'Left panel',
  'layout.document': 'Document',
  'layout.rightPanel': 'Right panel',
  'layout.rightRail': 'Right rail',
  'layout.statusBar': 'Status bar',
  'panel.close': 'Close {title}',
  'panel.state.expanded': 'Expanded',
  'panel.state.collapsed': 'Collapsed',
  'overlay.close': 'Close',

  // Engine load stages (W3.1) and the load failure dialog.
  'loading.stage.pyodide': 'Loading the Python runtime',
  'loading.stage.packages': 'Loading the PDF libraries',
  'loading.stage.engine': 'Starting the PDF engine',
  'loading.stage.ready': 'Ready',
  'loading.failed.title': 'Elanero could not start',
  'loading.failed.pyodide':
    'The Python runtime could not be loaded. Check your connection, then try again.',
  'loading.failed.packages':
    'The PDF libraries could not be loaded. Check your connection, then try again.',
  'loading.failed.engine':
    'The PDF engine could not start. Try again; if it keeps failing, reload the page.',
  'loading.retry': 'Try again',

  // Engine not responding and restart (W1.1 section 1, W4.4b). Final wording comes with W4.4b.
  'engine.notResponding.title': 'Elanero is still working',
  'engine.notResponding.body':
    'Elanero is still working on this. You can wait, or restart the engine.',
  'engine.notResponding.wait': 'Wait',
  'engine.restart.title': 'Restart the engine?',
  'engine.restart.body':
    'The engine will restart and reopen your documents from their last autosave. Changes made since then and the undo history will be lost.',
  'engine.restart.confirm': 'Restart engine',

  // Update prompt for a new app version (W4.6).
  'update.ready': 'A new version of Elanero is ready.',
  'update.reload': 'Reload',

  // Recommended-action labels (see src/rpc/errors.ts).
  'action.retry': 'Try again',
  'action.dismiss': 'OK',
  'action.wait': 'Wait',
  'action.restartEngine': 'Restart engine',
  'action.askPassword': 'Enter password',
  'action.saveAsNew': 'Save as a new file',
  'action.reloadPage': 'Reload page',
  'action.closeDocument': 'Close document',

  // One message per RPC error code (W1.2 section 4), plus the variants the mapping chooses.
  'error.UNKNOWN': 'Something went wrong. Try again; if it keeps happening, reload the page.',
  'error.INVALID_REQUEST':
    'Elanero sent a request the engine does not know. Reload the page and try again.',
  'error.INVALID_ARGS':
    'Elanero sent a request with details the engine does not accept. Reload the page and try again.',
  'error.PROTOCOL_MISMATCH':
    'This page and the PDF engine are different versions. Reload the page to get both.',
  'error.NO_DOCUMENT': 'This document is no longer open.',
  'error.PASSWORD_REQUIRED': 'This file is protected. Enter its password to open it.',
  'error.WRONG_PASSWORD': 'That password is not correct. Try again.',
  'error.OPEN_FAILED': 'This file could not be opened. It is not a PDF, or it is damaged.',
  'error.SAVE_FAILED': 'The document could not be saved. Your changes are still here; try again.',
  'error.SAVE_FAILED.signed':
    'The document could not be saved in place, and a signed document must not be rewritten. Save it as a new file instead; the signatures stay in the original.',
  'error.REFUSED': 'This action cannot be done on this document.',
  'error.BUSY': 'Wait for the current task to finish, then try again.',
  'error.NOT_SUPPORTED': 'This is not available in the web version.',
  'error.STALE_OBJECT': 'The page changed since you last looked. Try again.',
  'error.STALE_CURSOR': 'The operation stopped because the document changed. Start it again.',
  'error.STALE_JOB': 'The engine restarted, so this result was dropped. Run the task again.',
  'error.CANCELLED': 'The operation was cancelled.',
  'error.FILE_TOO_LARGE': 'This file is larger than the web version can open (limit {limit}).',
  'error.FILE_TOO_LARGE.noLimit': 'This file is larger than the web version can open.',
  'error.TOO_MANY_PAGES': 'This document has more pages than the web version can handle.',
  'error.RENDER_TOO_LARGE': 'This page is too large to show at this zoom. Zoom out and try again.',
  'error.INVALID_FONT': 'This font file could not be read. Choose a different font file.',
  'error.FONT_NOT_EMBEDDABLE':
    'This font cannot be added because its licence does not allow embedding. Choose a different font.',
  'error.IMAGE_TOO_LARGE': 'This image is too large to add to the document. Use a smaller image.',
  'error.OUT_OF_MEMORY':
    'The browser ran out of memory. Close other documents or tabs, then try again.',
  'error.ENGINE_ERROR': 'The PDF engine reported an error while doing this. Try again.',
  'error.TRANSLATION_OFFLINE':
    'The translation service cannot be reached. Check your connection and try again.',
  'error.TRANSLATION_QUOTA':
    'The translation service has reached its usage limit. Try again later.',
  'error.TRANSLATION_AUTH':
    'The translation service rejected the key. Check the key in Preferences.',
  'error.TRANSLATION_CONFIG': 'The translation service is not set up. Add its key in Preferences.',
  'error.TRANSLATION_TOO_LONG':
    'The selected text is too long to translate at once. Select less text and try again.',
  'error.TRANSLATION_SAME_LANGUAGE': 'The text is already in the target language.',
  'error.TRANSLATION_SERVICE': 'The translation service returned an error. Try again.',
  'error.INTERNAL':
    'Something went wrong inside Elanero. Try again; if it keeps happening, reload the page.',
  'error.TIMEOUT': 'Elanero is still working on this. You can wait, or restart the engine.',
} as const;

export type MessageId = keyof typeof EN;
