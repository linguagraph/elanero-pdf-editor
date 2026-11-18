import { APP_VERSION } from './version';

// AGPL-3.0 section 13 asks for a way to get the source of the running program, so the About
// page links to the exact commit this build came from.
export const SOURCE_URL = `https://github.com/linguagraph/elanero-pdf-editor/tree/${__APP_COMMIT__}`;

export function About() {
  return (
    <section aria-labelledby="about-title">
      <h2 id="about-title">About Elanero</h2>
      <p>Version {APP_VERSION}</p>
      <p>Licence: AGPL-3.0-or-later</p>
      <p>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          Source code
        </a>
      </p>
    </section>
  );
}
