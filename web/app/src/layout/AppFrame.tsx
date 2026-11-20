import { type MouseEvent, type ReactNode, useRef } from 'react';
import { t } from '../i18n/t';
import { layoutForWidth } from './breakpoints';
import { LayoutProvider } from './LayoutContext';
import type { Side } from './sidePanels';
import { focusRegion, useFocusRegions } from './useFocusRegions';
import { useDismissablePanels } from './useDismissablePanels';
import { useViewportWidth } from './useViewportWidth';
import './layout.css';

export interface AppFrameProps {
  // The top bar: brand, quick access and, later, the ribbon (W4.3a).
  header: ReactNode;
  leftRail?: ReactNode;
  leftPanel?: ReactNode;
  children: ReactNode;
  rightPanel?: ReactNode;
  rightRail?: ReactNode;
  statusBar?: ReactNode;
  // The start page replaces the rails too (W1.6 section 1), so they are hidden while it shows.
  readonly railsHidden?: boolean;
  // Escape or a tap outside closes a floating (drawer or overlay) panel through this (S3).
  readonly onDismissPanel?: (side: Side) => void;
}

// The app's region frame, in the desktop order (W1.6 section 1). The regions are always in the
// DOM in that order, so keyboard order follows it. Which ones show, and whether a panel docks or
// floats, is decided by the breakpoint helper; CSS reads that as data attributes on the frame.
export function AppFrame({
  header,
  leftRail,
  leftPanel,
  children,
  rightPanel,
  rightRail,
  statusBar,
  railsHidden = false,
  onDismissPanel,
}: AppFrameProps) {
  const regions = layoutForWidth(useViewportWidth());
  const hasLeftPanel = leftPanel !== undefined && leftPanel !== null && leftPanel !== false;
  const hasRightPanel = rightPanel !== undefined && rightPanel !== null && rightPanel !== false;
  const frameRef = useRef<HTMLDivElement>(null);
  useFocusRegions();
  useDismissablePanels({
    frame: frameRef,
    shown: { left: hasLeftPanel, right: hasRightPanel },
    floating: { left: regions.leftPanel === 'drawer', right: regions.rightPanel === 'overlay' },
    onDismiss: onDismissPanel,
  });

  // The skip link moves the keyboard past the header, the rails and the panels to the document.
  const skipToDocument = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    focusRegion('page');
  };

  const frame = (
    <div
      ref={frameRef}
      className="app-frame"
      data-tier={regions.tier}
      data-ribbon={regions.ribbon}
      data-left-rail={regions.leftRail ? 'shown' : 'hidden'}
      data-left-panel={hasLeftPanel ? regions.leftPanel : 'none'}
      data-right-panel={hasRightPanel ? regions.rightPanel : 'none'}
      data-rails={railsHidden ? 'hidden' : 'shown'}
    >
      <a href="#app-page-area" className="app-skip-link" onClick={skipToDocument}>
        {t('layout.skipToDocument')}
      </a>
      <header className="app-frame-header" data-region="ribbon">
        {header}
      </header>
      <div className="app-frame-body">
        <div
          className="app-rail app-rail-left"
          data-region="left"
          role="toolbar"
          aria-orientation="vertical"
          aria-label={t('layout.leftRail')}
        >
          {leftRail}
        </div>
        {hasLeftPanel ? (
          <aside
            id="app-panel-left"
            className="app-panel app-panel-left"
            data-region="left"
            aria-label={t('layout.leftPanel')}
          >
            {leftPanel}
          </aside>
        ) : null}
        <main
          id="app-page-area"
          className="app-page-area"
          data-region="page"
          tabIndex={-1}
          aria-label={t('layout.document')}
        >
          {children}
        </main>
        {hasRightPanel ? (
          <aside
            id="app-panel-right"
            className="app-panel app-panel-right"
            data-region="right"
            aria-label={t('layout.rightPanel')}
          >
            {rightPanel}
          </aside>
        ) : null}
        <div
          className="app-rail app-rail-right"
          data-region="right"
          role="toolbar"
          aria-orientation="vertical"
          aria-label={t('layout.rightRail')}
        >
          {rightRail}
        </div>
      </div>
      {statusBar ? (
        <footer
          className="app-frame-status"
          data-region="status"
          aria-label={t('layout.statusBar')}
        >
          {statusBar}
        </footer>
      ) : null}
    </div>
  );
  return <LayoutProvider regions={regions}>{frame}</LayoutProvider>;
}
