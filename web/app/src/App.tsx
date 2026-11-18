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
import { BRAND } from './theme/tokens';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { APP_VERSION } from './version';
import './app.css';

// No document is open yet, so the state every command reads is empty.
const NO_DOCUMENT_STATE: CommandState = {
  hasDocument: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(),
};

// Placeholder shell: the region frame is in place (W4.2a); the ribbon, start page and features
// come with W4.2b onwards.
export function App() {
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const handlers: CommandHandlers = { preferences: () => setPreferencesOpen(true) };
  return (
    <AppFrame
      header={
        <div className="app-header">
          <span className="brand">{BRAND.name}</span>
          <button
            type="button"
            onClick={() => runCommand(REGISTRY, 'preferences', NO_DOCUMENT_STATE, handlers)}
          >
            {t('command.preferences.label')}
          </button>
          <ThemeSwitch />
        </div>
      }
    >
      <PreferencesDialog isOpen={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
      <div className="app-main">
        <UpdatePrompt />
        <EngineLoadingScreen />
        <ToastRegion />
        <h1>{t('app.name')}</h1>
        <p>{t('app.version', { version: APP_VERSION })}</p>
        <About />
      </div>
    </AppFrame>
  );
}
