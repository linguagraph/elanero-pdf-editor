// The status bar under the document (W1.6 section 1, the status bar region): Back and Forward through
// the navigation history (W5.3), then the zoom and the page layout. The page jump moved to the canvas
// pill (W4.2a S5), and Back and Forward also run from the ribbon's Home tab and Alt+Left/Right (S6).
import { t } from '../i18n/t';
import type { ViewLayout } from './layout';
import './documentView.css';

export interface DocumentStatusBarProps {
  readonly zoom: number;
  // The page layout the reader chose; shown at the right end, after the zoom. Required, so a caller
  // cannot leave the status bar on its default.
  readonly layout: ViewLayout;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
}

export function DocumentStatusBar({
  zoom,
  layout,
  canBack,
  canForward,
  onBack,
  onForward,
}: DocumentStatusBarProps) {
  // Back and Forward on the left; zoom and the view mode on the right (desktop order, W1.6 section 1).
  return (
    <div className="doc-status">
      <div className="doc-status-start">
        <button type="button" onClick={onBack} disabled={!canBack}>
          {t('view.back')}
        </button>
        <button type="button" onClick={onForward} disabled={!canForward}>
          {t('view.forward')}
        </button>
      </div>
      <div className="doc-status-end">
        <span className="doc-status-zoom">
          {t('view.zoomPercent', { percent: Math.round(zoom * 100) })}
        </span>
        <span className="doc-status-mode">
          {t(layout === 'twoPage' ? 'view.layoutTwoPage' : 'view.layoutSingle')}
        </span>
      </div>
    </div>
  );
}
