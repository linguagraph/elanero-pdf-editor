// The XFDF import calls (W7.2 A5, W1.5 section 10). The file is checked against the size limit
// before it is read, so an oversize file is never loaded into memory. The engine checks the same
// limit again (services/xfdf.py), so the client check is only the first line of defence.
import type { PageRpc } from '../engine/engineConnection';
import type { Methods } from '../rpc/generated';

// Mirrors MAX_XFDF_BYTES in src/pdfeditor/services/xfdf.py (8 MiB). Change both together.
export const MAX_XFDF_BYTES = 8 * 1024 * 1024;

export const IMPORT_ACTION = 'annotations.import_xfdf';

export type XfdfPreview = Methods['comments.xfdf_preview']['result'];

// Thrown before reading when the file is over the limit. The dialog shows the too-large message.
export class XfdfTooLarge extends Error {
  constructor() {
    super('the XFDF file is too large');
    this.name = 'XfdfTooLarge';
  }
}

// Reads the file's text (UTF-8; a byte order mark is dropped by the decoder). The size is checked
// from the File before any byte is read.
export async function readXfdf(file: File): Promise<string> {
  if (file.size > MAX_XFDF_BYTES) throw new XfdfTooLarge();
  return file.text();
}

// The counts the import would add, read by the engine without changing the document.
export function previewXfdf(rpc: PageRpc, handle: string, text: string): Promise<XfdfPreview> {
  return rpc.call('comments.xfdf_preview', { handle, text });
}

// Adds the comments as one undoable step (annotations.import_xfdf).
export function importXfdf(rpc: PageRpc, handle: string, text: string) {
  return rpc.call('actions.run', { handle, name: IMPORT_ACTION, args: { text } });
}

// The number of comments the import added (its value), or 0 when the engine sent none.
export function importedCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
