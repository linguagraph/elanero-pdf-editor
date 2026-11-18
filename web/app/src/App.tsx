import { useState } from 'react';
import { About } from './about';
import { REGISTRY } from './commands/catalog';
import { type CommandHandlers, runCommand } from './commands/run';
import { type CommandState } from './commands/registry';
import { t } from './i18n/t';
import { EngineLoadingScreen } from './feedback/LoadingScreen';
import { ToastRegion } from './feedback/ToastRegion';
import { UpdatePrompt } from './pwa/UpdatePrompt';
import { AppFrame } from './layout/AppFrame';
import { BrandMark } from './theme/BrandMark';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { useDocuments } from './documents/useDocuments';
import { OpenInput } from './documents/OpenInput';
import { StartPage } from './start/StartPage';
import { DocumentTabs } from './tabs/DocumentTabs';
import { useTabSession } from './engine/engineConnection';
import { DocumentView } from './view/DocumentView';
import { APP_VERSION } from './version';
import './app.css';

// No document is open yet, so the state every command reads is empty.
const NO_DOCUMENT_STATE: CommandState = {
  hasDocument: false,
  hasRecentFiles: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(),
};

// Placeholder shell: the region frame is in place (W4.2a); the ribbon and the features come later.
// The start page and the document tabs (W4.2b) are in place.
export function App() {
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const docs = useDocuments();
  const state: CommandState = { ...NO_DOCUMENT_STATE, hasRecentFiles: docs.recent.length > 0 };
  const handlers: CommandHandlers = {
    preferences: () => setPreferencesOpen(true),
    open: () => docs.openPicker(),
    'open-recent': () => docs.showStartPage(),
  };
  const showStart = docs.tabs.tabs.length === 0 || docs.showStart;
  const activeId = docs.tabs.activeId;
  const session = useTabSession(activeId);
  return (
    <AppFrame
      header={
        <div className="app-header">
          <BrandMark />
          <button
            type="button"
            onClick={() => runCommand(REGISTRY, 'preferences', state, handlers)}
          >
            {t('command.preferences.label')}
          </button>
          <ThemeSwitch />
        </div>
      }
    >
      <PreferencesDialog isOpen={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
      <OpenInput inputRef={docs.inputRef} onFiles={docs.openFiles} />
      <DocumentTabs state={docs.tabs} onSelect={docs.selectTab} onClose={docs.closeTab} />
      <div className="app-main">
        <UpdatePrompt />
        <EngineLoadingScreen />
        <ToastRegion />
        {showStart ? (
          <StartPage
            recent={docs.recent}
            pickHint={docs.pickHint}
            onOpen={() => docs.openPicker()}
            onRecent={(name) => docs.openPicker(name)}
            onFiles={docs.openFiles}
          />
        ) : null}
        {!showStart && activeId !== null && session !== null ? (
          <DocumentView key={activeId} rpc={session.rpc} handle={session.handle} />
        ) : null}
        <h1>{t('app.name')}</h1>
        <p>{t('app.version', { version: APP_VERSION })}</p>
        <About />
      </div>
    </AppFrame>
  );
}
