// Turning the Edit tool on (W6.7a S4), or a shape tool (W6.7b). Both change the document, so a
// signed document warns once per tab, as the desktop's confirm_signed does: the first ask on that
// tab waits for the warning, and Cancel leaves the tool off, so the next ask warns again. The warned
// tabs are kept for the session; a tab id is never reused, so a closed tab's entry is harmless.
import { setViewTool, type ShapeTool } from '../view/viewTool';

// The tools that edit the page content, and so need the signed-document warning first.
export type EditTool = 'edit' | 'image' | 'add-text' | ShapeTool;

const warnedTabs = new Set<number>();

// Turns an editing tool on for the tab. Returns true when it is on; false when a signed document
// has not been warned about on this tab yet, and the warning must be asked first.
export function requestEditTool(tabId: number, signed: boolean, tool: EditTool = 'edit'): boolean {
  if (signed && !warnedTabs.has(tabId)) return false;
  setViewTool(tabId, tool);
  return true;
}

// The user accepted the signed-document warning: the tab is not warned again, and the tool turns on.
export function acceptSignedEdit(tabId: number, tool: EditTool = 'edit'): void {
  warnedTabs.add(tabId);
  setViewTool(tabId, tool);
}
