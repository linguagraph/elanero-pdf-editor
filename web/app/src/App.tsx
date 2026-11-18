import { About } from './about';
import { t } from './i18n/t';
import { EngineLoadingScreen } from './feedback/LoadingScreen';
import { ToastRegion } from './feedback/ToastRegion';
import { UpdatePrompt } from './pwa/UpdatePrompt';
import { AppFrame } from './layout/AppFrame';
import { BRAND } from './theme/tokens';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { APP_VERSION } from './version';
import './app.css';

// Placeholder shell: the region frame is in place (W4.2a); the ribbon, start page and features
// come with W4.2b onwards.
export function App() {
  return (
    <AppFrame
      header={
        <div className="app-header">
          <span className="brand">{BRAND.name}</span>
          <ThemeSwitch />
        </div>
      }
    >
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
