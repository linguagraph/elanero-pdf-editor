// The content of the status bar under the document (#808 slice 1): the page and zoom controls, centred.
// Back and Forward are in the ribbon's Home tab and on Alt+Left/Right; the zoom and the layout are
// shown by the zoom box and the ribbon's View toggles, so the bar has no text of its own.
import { StatusControls, type StatusControlsProps } from './StatusControls';
import './documentView.css';

export type DocumentStatusBarProps = StatusControlsProps;

export function DocumentStatusBar(props: DocumentStatusBarProps) {
  return (
    <div className="doc-status">
      <StatusControls {...props} />
    </div>
  );
}
