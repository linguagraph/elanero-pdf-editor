import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { layoutForWidth } from './breakpoints';
import { LayoutProvider } from './LayoutContext';
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
}: AppFrameProps) {
  const regions = layoutForWidth(useViewportWidth());
  const hasLeftPanel = leftPanel !== undefined && leftPanel !== null && leftPanel !== false;
  const hasRightPanel = rightPanel !== undefined && rightPanel !== null && rightPanel !== false;

  const frame = (
    <div
      className="app-frame"
      data-tier={regions.tier}
      data-ribbon={regions.ribbon}
      data-left-rail={regions.leftRail ? 'shown' : 'hidden'}
      data-left-panel={hasLeftPanel ? regions.leftPanel : 'none'}
      data-right-panel={hasRightPanel ? regions.rightPanel : 'none'}
    >
      <header className="app-frame-header">{header}</header>
      <div className="app-frame-body">
        <nav className="app-rail app-rail-left" aria-label={t('layout.leftRail')}>
          {leftRail}
        </nav>
        {hasLeftPanel ? (
          <aside
            id="app-panel-left"
            className="app-panel app-panel-left"
            aria-label={t('layout.leftPanel')}
          >
            {leftPanel}
          </aside>
        ) : null}
        <main className="app-page-area" aria-label={t('layout.document')}>
          {children}
        </main>
        {hasRightPanel ? (
          <aside
            id="app-panel-right"
            className="app-panel app-panel-right"
            aria-label={t('layout.rightPanel')}
          >
            {rightPanel}
          </aside>
        ) : null}
        <nav className="app-rail app-rail-right" aria-label={t('layout.rightRail')}>
          {rightRail}
        </nav>
      </div>
      {statusBar ? (
        <footer className="app-frame-status" aria-label={t('layout.statusBar')}>
          {statusBar}
        </footer>
      ) : null}
    </div>
  );
  return <LayoutProvider regions={regions}>{frame}</LayoutProvider>;
}
