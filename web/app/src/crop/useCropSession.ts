// The crop dialog's session in the app (W4.11 S5): whether the dialog is open, the form as the user
// left it, and the box drawn on a page. The form is kept only across the Draw on page round trip; a
// cancel, a successful crop, or a change of tab clears it, so each fresh open starts from the
// defaults. The crop box tool belongs to its tab and is left when that tab is switched away from or
// closed.
import { useEffect, useRef, useState } from 'react';
import { leaveCropBox, setViewTool } from '../view/viewTool';
import type { CropValues, DrawnCrop } from './cropChoice';

export interface CropSession {
  readonly open: boolean;
  readonly values: CropValues | undefined;
  readonly drawn: DrawnCrop | null;
  // Opens the dialog from the Crop command, with the kept form if there is one.
  readonly openDialog: () => void;
  // Closes the dialog and starts the crop box tool on the active tab. The form is kept.
  readonly drawOnPage: () => void;
  // The crop box ended: a drawn box (or null for Esc) reopens the dialog with its margins.
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
  // A change of tab clears the session. Done while rendering, so no effect sets state.
  const [seenTab, setSeenTab] = useState(activeId);
  if (seenTab !== activeId) {
    setSeenTab(activeId);
    setOpen(false);
    setValuesState(undefined);
    setDrawn(null);
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
    openDialog: () => setOpen(true),
    drawOnPage: () => {
      setOpen(false);
      setDrawn(null);
      if (activeId !== null) setViewTool(activeId, 'cropBox');
    },
    boxEnded: (next) => {
      if (activeId !== null) setViewTool(activeId, 'select');
      setDrawn(next);
      setOpen(true);
    },
    close: () => {
      setOpen(false);
      setDrawn(null);
      setValuesState(undefined);
    },
    setValues: setValuesState,
  };
}
