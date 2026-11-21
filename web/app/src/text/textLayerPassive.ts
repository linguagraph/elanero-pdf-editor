import type { CommentToolId } from '../comments/tools';
import { isShapeTool, type ViewTool } from '../view/viewTool';

export interface GestureTools {
  readonly commentTool: CommentToolId | null;
  readonly viewTool: ViewTool;
  readonly markToolOn: boolean;
}

// Whether the text layer lets the pointer through. The comment, redaction mark, crop box and shape
// layers all draw with a drag and sit below the text layer, so while one is armed the text spans
// would take the drag and start a native selection instead.
export function textLayerPassive({ commentTool, viewTool, markToolOn }: GestureTools): boolean {
  return commentTool !== null || markToolOn || viewTool === 'cropBox' || isShapeTool(viewTool);
}
