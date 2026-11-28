import { type MouseEvent, type ReactNode, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { LAYOUT_PX } from '../theme/tokens';
import { layoutForWidth } from './breakpoints';
import { LayoutProvider } from './LayoutContext';
import { PanelResizer } from './PanelResizer';
import { clampPanelWidth, maxPanelWidth, readPanelWidths, writePanelWidth } from './panelWidths';
import type { PanelWidths } from './panelWidths';
import type { Side } from './sidePanels';
import { focusDocument, useFocusRegions } from './useFocusRegions';
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
  statusBar,
  railsHidden = false,
  onDismissPanel,
}: AppFrameProps) {
  const windowWidth = useViewportWidth();
  const regions = layoutForWidth(windowWidth);
  // The remembered widths, kept clamped to the window for display; the stored value is not changed
  // by a narrower window, so a wider one shows the panel at its remembered width again.
  const [widths, setWidths] = useState<PanelWidths>(readPanelWidths);
  const shownWidth: PanelWidths = {
    left: clampPanelWidth(widths.left, windowWidth, regions.tier),
    right: clampPanelWidth(widths.right, windowWidth, regions.tier),
  };
  const maxWidth = maxPanelWidth(windowWidth, regions.tier);
  const showWidth = (side: Side, width: number) => {
    setWidths((previous) => ({ ...previous, [side]: width }));
  };
  const saveWidth = (side: Side, width: number) => {
    showWidth(side, width);
    writePanelWidth(side, width);
  };
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
    focusDocument();
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
            style={{ width: shownWidth.left, flexBasis: shownWidth.left }}
          >
            {leftPanel}
            <PanelResizer
              side="left"
              value={shownWidth.left}
              min={LAYOUT_PX.minPanelWidth}
              max={maxWidth}
              onChange={(width) => {
                showWidth('left', width);
              }}
              onCommit={(width) => {
                saveWidth('left', width);
              }}
            />
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
            style={{ width: shownWidth.right, flexBasis: shownWidth.right }}
          >
            {rightPanel}
            <PanelResizer
              side="right"
              value={shownWidth.right}
              min={LAYOUT_PX.minPanelWidth}
              max={maxWidth}
              onChange={(width) => {
                showWidth('right', width);
              }}
              onCommit={(width) => {
                saveWidth('right', width);
              }}
            />
          </aside>
        ) : null}
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
