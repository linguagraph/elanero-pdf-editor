// The comment tools the web offers (W7.1a). The names are the ones the actions layer's
// annotations.create takes (src/pdfeditor/actions/comment_tools.py), so they are sent unchanged.
import type { MessageId } from '../i18n/en';

export type CommentToolId = 'note' | 'rectangle' | 'highlight';

export const COMMENT_TOOLS: readonly CommentToolId[] = ['note', 'rectangle', 'highlight'];

export const COMMENT_TOOL_LABEL: Readonly<Record<CommentToolId, MessageId>> = {
  note: 'comment.tool.note',
  rectangle: 'comment.tool.rectangle',
  highlight: 'comment.tool.highlight',
};

// A sticky note is placed by a click; a rectangle and a highlight by a drag.
export function isDragTool(tool: CommentToolId): boolean {
  return tool !== 'note';
}
