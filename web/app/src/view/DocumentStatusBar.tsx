// The status bar under the document (W1.6 section 1, the status bar region): the page the reader is
// on, of the total, and the zoom. The page and zoom come from the document view, which reports them.
import { t } from '../i18n/t';
import './documentView.css';

export interface DocumentStatusBarProps {
  // One-based page at the middle of the viewport, and the number of pages in the document.
  readonly page: number;
  readonly total: number;
  readonly zoom: number;
}

export function DocumentStatusBar({ page, total, zoom }: DocumentStatusBarProps) {
  return (
    <div className="doc-status">
      <span className="doc-status-page" aria-live="polite">
        {t('view.pageNumber', { page, total })}
      </span>
      <span className="doc-status-zoom">
        {t('view.zoomPercent', { percent: Math.round(zoom * 100) })}
      </span>
    </div>
  );
}
