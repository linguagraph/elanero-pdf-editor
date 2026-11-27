import { useId } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { useLayoutRegions } from '../layout/LayoutContext';
import { Icon } from '../theme/Icon';
import { t } from '../i18n/t';
import { DocumentTabMenu } from './DocumentTabMenu';
import type { TabState } from './tabState';
import './tabs.css';

export interface DocumentTabsProps {
  readonly state: TabState;
  onSelect(id: number): void;
  onClose(id: number): void;
  // Runs the open command, the same one as the ribbon's Open, for the + button after the strip.
  onOpen(): void;
}

// The strip of open documents (W1.6 section 3). The tabs are a react-aria TabList, so the arrow
// keys move between them and Home and End jump to the ends. Delete closes the focused tab (Ctrl+W
// closes the active one too). The close mark is pointer-only and hidden from assistive technology:
// a button inside the tab would be nested interactive content (W8.5 S8). A dot marks a tab with
// unsaved changes, and the screen reader text says so too. At the tablet and phone tiers (below
// 1024 px) the strip becomes a drop-down list.
//
// react-aria points the selected tab's aria-controls at a tab panel with the tab's key. The strip
// renders only that one panel, hidden: the document view is not inside the strip, and an
// aria-controls to a missing element fails axe.
export function DocumentTabs({ state, onSelect, onClose, onOpen }: DocumentTabsProps) {
  const { tier } = useLayoutRegions();
  if (state.tabs.length === 0) return null;
  if (tier === 'tablet' || tier === 'phone') {
    return (
      <>
        <DocumentTabMenu state={state} onSelect={onSelect} onClose={onClose} />
        <OpenButton onOpen={onOpen} />
      </>
    );
  }
  return (
    <>
      <TabStrip state={state} onSelect={onSelect} onClose={onClose} />
      <OpenButton onOpen={onOpen} />
    </>
  );
}

// The wide-tier tab list (W1.6 section 3), kept apart so the + button can follow it in the strip.
function TabStrip({ state, onSelect, onClose }: Omit<DocumentTabsProps, 'onOpen'>) {
  const hintId = useId();
  // react-aria does not pass onKeyDown through Tabs or TabList, so Delete is caught on this wrapper,
  // in the capture phase: react-aria's collection handler may stop the event before it bubbles.
  return (
    <div
      className="doc-tabs"
      onKeyDownCapture={(event) => {
        if (event.key !== 'Delete') return;
        // The DOM id of a react-aria tab is not its key, so the tab's place in the strip finds it.
        const dom = [...event.currentTarget.querySelectorAll('[role="tab"]')];
        const tab = (event.target as Element).closest('[role="tab"]');
        const index = tab === null ? -1 : dom.indexOf(tab);
        const target = state.tabs[index];
        if (target !== undefined) {
          event.preventDefault();
          // Closing removes the focused tab, which would drop focus to the body. The neighbour
          // (the next tab, or the previous one when the closed tab was last) takes focus first.
          const neighbour = dom[index + 1] ?? dom[index - 1];
          if (neighbour instanceof HTMLElement) neighbour.focus();
          onClose(target.id);
        }
      }}
    >
      <Tabs
        selectedKey={state.activeId === null ? undefined : String(state.activeId)}
        onSelectionChange={(key) => {
          onSelect(Number(key));
        }}
      >
        <span id={hintId} className="visually-hidden">
          {t('tabs.closeHint')}
        </span>
        <TabList aria-label={t('tabs.label')} className="doc-tabs-list">
          {state.tabs.map((tab) => (
            <Tab key={tab.id} id={String(tab.id)} className="doc-tab" aria-describedby={hintId}>
              <span className="doc-tab-name" title={tab.name}>
                {tab.name}
              </span>
              {tab.dirty ? (
                <span className="doc-tab-dirty">
                  <span aria-hidden="true">•</span>
                  <span className="visually-hidden">{t('tabs.unsaved')}</span>
                </span>
              ) : null}
              <span
                className="doc-tab-close"
                aria-hidden="true"
                title={t('tabs.close', { name: tab.name })}
                onPointerDown={(event) => {
                  // The press belongs to the close mark, not the tab: no selection change.
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </span>
            </Tab>
          ))}
        </TabList>
        {state.activeId === null ? null : (
          <TabPanel id={String(state.activeId)} className="doc-tabs-panel" />
        )}
      </Tabs>
    </div>
  );
}

// The + button after the strip (W1.6 S2.5). Its name is the open command's label, so it reads the
// same as the ribbon's Open to a screen reader.
function OpenButton({ onOpen }: { readonly onOpen: () => void }) {
  const name = t('command.open.label');
  // react-aria's Button does not pass a title through to the DOM, so the native title is set on
  // the element once it mounts (the name is fixed, so it never needs updating).
  return (
    <Button
      className="doc-strip-open"
      aria-label={name}
      onPress={onOpen}
      ref={(element) => {
        element?.setAttribute('title', name);
      }}
    >
      <Icon name="plus" size={16} />
    </Button>
  );
}
