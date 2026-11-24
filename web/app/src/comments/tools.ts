// The comment tools the web offers (W7.1a). The names are the ones the actions layer's
// annotations.create takes (src/pdfeditor/actions/comment_tools.py), so they are sent unchanged.
import type { MessageId } from '../i18n/en';

export type CommentToolId =
  | 'note'
  | 'rectangle'
  | 'highlight'
  | 'textbox'
  | 'oval'
  | 'line'
  | 'arrow'
  | 'callout'
  | 'pen'
  | 'polygon'
  | 'polyline';

export const COMMENT_TOOLS: readonly CommentToolId[] = [
  'note',
  'rectangle',
  'highlight',
  'textbox',
  'oval',
  'line',
  'arrow',
  'callout',
  'pen',
  'polygon',
  'polyline',
];

export const COMMENT_TOOL_LABEL: Readonly<Record<CommentToolId, MessageId>> = {
  note: 'comment.tool.note',
  rectangle: 'comment.tool.rectangle',
  highlight: 'comment.tool.highlight',
  textbox: 'comment.tool.textbox',
  oval: 'comment.tool.oval',
  line: 'comment.tool.line',
  arrow: 'comment.tool.arrow',
  callout: 'comment.tool.callout',
  pen: 'comment.tool.pen',
  polygon: 'comment.tool.polygon',
  polyline: 'comment.tool.polyline',
};

// How a tool takes its gesture. A click places a sticky note; a text box is a drag or a click,
// then its text; a rectangle, oval or highlight is a drag of its box; a line or arrow is a drag
// from one end to the other. A callout is a click on its tip, then a box (a drag or a click),
// then its text. A pen is a drag that draws a stroke; a polygon or polyline takes a click per
// vertex and finishes on a double-click (or Enter).
export type GestureKind = 'click' | 'text' | 'box' | 'line' | 'callout' | 'stroke' | 'poly';

export const GESTURE_KIND: Readonly<Record<CommentToolId, GestureKind>> = {
  note: 'click',
  textbox: 'text',
  rectangle: 'box',
  oval: 'box',
  highlight: 'box',
  line: 'line',
  arrow: 'line',
  callout: 'callout',
  pen: 'stroke',
  polygon: 'poly',
  polyline: 'poly',
};
