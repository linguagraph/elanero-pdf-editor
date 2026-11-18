import { About } from './about';
import { t } from './i18n/t';
import { APP_VERSION } from './version';

// Placeholder shell: no feature code yet (W4.3 onwards).
export function App() {
  return (
    <main>
      <h1>{t('app.name')}</h1>
      <p>{t('app.version', { version: APP_VERSION })}</p>
      <About />
    </main>
  );
}
