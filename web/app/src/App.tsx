import { About } from './about';
import { t } from './i18n/t';
import { BRAND } from './theme/tokens';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { APP_VERSION } from './version';
import './app.css';

// Placeholder shell: no feature code yet (W4.3 onwards).
export function App() {
  return (
    <>
      <header className="app-header">
        <span className="brand">{BRAND.name}</span>
        <ThemeSwitch />
      </header>
      <main className="app-main">
        <h1>{t('app.name')}</h1>
        <p>{t('app.version', { version: APP_VERSION })}</p>
        <About />
      </main>
    </>
  );
}
