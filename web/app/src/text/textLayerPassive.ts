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

// Whether the page's links take presses (W5.3): under Select and Hand only. The Edit and crop box
// tools and the comment and mark tools draw with the pointer, so they get every press and the page
// offers no tab stops that do nothing.
export function linksActive({ commentTool, viewTool, markToolOn }: GestureTools): boolean {
  if (viewTool !== 'select' && viewTool !== 'hand') return false;
  return commentTool === null && !markToolOn;
}
