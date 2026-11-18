import { t } from './i18n/t';
import { APP_VERSION } from './version';

// AGPL-3.0 section 13 asks for a way to get the source of the running program, so the About
// page links to the exact commit this build came from.
export const SOURCE_URL = `https://github.com/linguagraph/elanero-pdf-editor/tree/${__APP_COMMIT__}`;

export function About() {
  return (
    <section aria-labelledby="about-title">
      <h2 id="about-title">{t('about.title')}</h2>
      <p>{t('app.version', { version: APP_VERSION })}</p>
      <p>{t('about.licence')}</p>
      <p>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t('about.source')}
        </a>
      </p>
    </section>
  );
}
