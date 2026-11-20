// The crop dialog's session in the app (W4.11 S5): whether the dialog is open, the form as the user
// left it, and the page the crop applies to when the form is scoped to the current page. The form is
// kept only across the Draw on page round trip; a cancel, a successful crop, a change of tab, or
// leaving the crop box tool by any other route (Hand, a comment or mark tool) clears it, so each
// fresh open starts from the defaults. Esc or a drawn box ends the crop box tool and keeps the form.
// The crop box tool belongs to its tab and is left when that tab is switched away from or closed.
import { useEffect, useRef, useState } from 'react';
import { leaveCropBox, setViewTool, useViewTool, type ViewTool } from '../view/viewTool';
import type { CropValues, DrawnCrop } from './cropChoice';

export interface CropSession {
  readonly open: boolean;
  readonly values: CropValues | undefined;
  // The box drawn on a page, while the dialog reopens with it (null after Esc or a fresh open).
  readonly drawn: DrawnCrop | null;
  // The page the kept form's "current page" scope targets: the page of the last drawn box, kept for
  // the session. Null when no box was drawn, so the scope means the page being viewed.
  readonly scopePage: number | null;
  // Opens the dialog from the Crop command, with the kept form if there is one.
  readonly openDialog: () => void;
  // Closes the dialog and starts the crop box tool on the active tab. The form is kept.
  readonly drawOnPage: () => void;
  // The crop box ended: a drawn box (or null for Esc) reopens the dialog, with the box's margins.
  readonly boxEnded: (drawn: DrawnCrop | null) => void;
  // A normal close (Cancel, a tap outside or Esc in the dialog, or a successful crop): clears the form.
  readonly close: () => void;
  readonly setValues: (values: CropValues) => void;
}

export function useCropSession(
  activeId: number | null,
  openTabIds: readonly number[],
): CropSession {
  const [open, setOpen] = useState(false);
  const [values, setValuesState] = useState<CropValues | undefined>(undefined);
  const [drawn, setDrawn] = useState<DrawnCrop | null>(null);
  const [scopePage, setScopePage] = useState<number | null>(null);
  // Set by the crop box's own end, so the tool leaving it keeps the form. Any other leave clears it.
  const [boxEnding, setBoxEnding] = useState(false);
  const tool = useViewTool(activeId);
  const clearSession = () => {
    setOpen(false);
    setValuesState(undefined);
    setDrawn(null);
    setScopePage(null);
  };
  // A change of tab clears the session, and so does a leave of the crop box tool that the box did
  // not end. Done while rendering, so no effect sets state.
  const [seenTab, setSeenTab] = useState(activeId);
  const [seenTool, setSeenTool] = useState<ViewTool>(tool);
  if (seenTab !== activeId) {
    setSeenTab(activeId);
    clearSession();
  }
  if (seenTool !== tool) {
    setSeenTool(tool);
    if (seenTool === 'cropBox' && tool !== 'cropBox' && !boxEnding) clearSession();
    if (boxEnding) setBoxEnding(false);
  }
  // The tab left by a switch or a close leaves the crop box tool.
  const lastTab = useRef(activeId);
  useEffect(() => {
    const left = lastTab.current;
    lastTab.current = activeId;
    if (left === null || left === activeId) return;
    leaveCropBox(left, openTabIds.includes(left));
  }, [activeId, openTabIds]);

  return {
    open,
    values,
    drawn,
    scopePage,
    openDialog: () => setOpen(true),
    drawOnPage: () => {
      setOpen(false);
      setDrawn(null);
      if (activeId !== null) setViewTool(activeId, 'cropBox');
    },
    boxEnded: (next) => {
      if (activeId !== null && tool === 'cropBox') {
        setBoxEnding(true);
        setViewTool(activeId, 'select');
      }
      if (next) setScopePage(next.page);
      setDrawn(next);
      setOpen(true);
    },
    close: clearSession,
    setValues: setValuesState,
  };
}
