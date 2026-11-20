import { Button, Tab, TabList, Tabs } from 'react-aria-components';
import { useLayoutRegions } from '../layout/LayoutContext';
import { t } from '../i18n/t';
import { DocumentTabMenu } from './DocumentTabMenu';
import type { TabState } from './tabState';
import './tabs.css';

export interface DocumentTabsProps {
  readonly state: TabState;
  onSelect(id: number): void;
  onClose(id: number): void;
}

// The strip of open documents (W1.6 section 3). The tabs are a react-aria TabList, so the arrow
// keys move between them and Home and End jump to the ends. Each tab has its own close button,
// named after the document. A dot marks a tab with unsaved changes, and the screen reader text
// says so too. At the tablet and phone tiers (below 1024 px) the strip becomes a drop-down list.
export function DocumentTabs({ state, onSelect, onClose }: DocumentTabsProps) {
  const { tier } = useLayoutRegions();
  if (state.tabs.length === 0) return null;
  if (tier === 'tablet' || tier === 'phone') {
    return <DocumentTabMenu state={state} onSelect={onSelect} onClose={onClose} />;
  }
  return (
    <Tabs
      className="doc-tabs"
      selectedKey={state.activeId === null ? undefined : String(state.activeId)}
      onSelectionChange={(key) => {
        onSelect(Number(key));
      }}
    >
      <TabList aria-label={t('tabs.label')} className="doc-tabs-list">
        {state.tabs.map((tab) => (
          <Tab key={tab.id} id={String(tab.id)} className="doc-tab">
            <span className="doc-tab-name" title={tab.name}>
              {tab.name}
            </span>
            {tab.dirty ? (
              <span className="doc-tab-dirty">
                <span aria-hidden="true">•</span>
                <span className="visually-hidden">{t('tabs.unsaved')}</span>
              </span>
            ) : null}
            <Button
              className="doc-tab-close"
              aria-label={t('tabs.close', { name: tab.name })}
              onPress={() => {
                onClose(tab.id);
              }}
            >
              <span aria-hidden="true">×</span>
            </Button>
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
