import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createEngineConnection } from './engine/engineConnection';
import { engineBootOptions, jobWorkerBootOptions } from './engine/bootOptions';
import { createJobWorkerPool } from './engine/jobPool';
import { createFontLibrary } from './fonts/fontLibrary';
import { FontLibraryContext } from './fonts/fontLibraryContext';
import { createFontStore } from './storage/fontStore';
import { startJobWorker } from './engine/start';
import { FRAME_REFUSAL_MESSAGE, shouldRefuse } from './frame';
import { registerAppServiceWorker } from './pwa/register';
import { installLaunchInbox, launchQueueOf } from './pwa/launch';
import { toasts } from './feedback/toasts';
import { startWithLocale } from './i18n/locale';
import { t } from './i18n/t';
import { readPreferences } from './prefs/store';
import { initAccent } from './theme/accent';
import { initReduceMotion } from './theme/motion';
import { initTheme } from './theme/theme';
import './theme/tokens.css';
import './theme/motion.css';

function mount(root: HTMLElement): void {
  // One engine connection per tab. App starts it after the first paint (W3.1).
  const engine = createEngineConnection({ boot: engineBootOptions() });
  // One job worker pool per tab (W3.1 slice 2): it starts no worker until App warms it.
  const jobs = createJobWorkerPool({ start: () => startJobWorker(jobWorkerBootOptions()) });
  // The tab's uploaded fonts (W6.9 slice 3): kept in the browser, sent to each new engine.
  const fonts = createFontLibrary({ engine, store: createFontStore() });
  // The OS "Open with" launches (W4.6 S1). The consumer is set here, before the first render, so a
  // launch is not held by the browser; App attaches the sink that opens the files.
  const launches = installLaunchInbox(launchQueueOf(window), {
    failed: (name) => toasts.push('error', t('open.launchFailed', { name })),
    tooMany: (max) => toasts.push('warning', t('open.launchTooMany', { max })),
  });
  createRoot(root).render(
    <StrictMode>
      <FontLibraryContext.Provider value={fonts}>
        <App
          engine={engine}
          fonts={fonts}
          jobs={jobs}
          startPrintWorker={jobs.acquire}
          launches={launches}
        />
      </FontLibraryContext.Provider>
    </StrictMode>,
  );
  // Production only: the dev server's modules must not sit behind a service worker cache.
  if (import.meta.env.PROD) {
    void registerAppServiceWorker();
  }
}

// The frame check runs before anything renders, so a framed copy never shows the app.
if (shouldRefuse(window)) {
  document.body.textContent = FRAME_REFUSAL_MESSAGE;
} else {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('index.html has no #root element');
  }
  initTheme();
  // The accent is applied before the first render too, so the default blue never flashes.
  initAccent();
  // The Reduce motion choice is applied before the first render too (W8.5 S6).
  initReduceMotion();
  // The chosen language's catalogue is loaded and applied before the first render, so English
  // never flashes first. English (and a missing or broken file) loads nothing.
  // A stalled, broken or throwing start-up still mounts the app, in English (see startWithLocale).
  const language = readPreferences().language;
  void startWithLocale(language, () => mount(root));
}
