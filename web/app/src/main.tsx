import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createEngineConnection } from './engine/engineConnection';
import { engineBootOptions, jobWorkerBootOptions } from './engine/bootOptions';
import { createJobWorkerPool } from './engine/jobPool';
import { startJobWorker } from './engine/start';
import { FRAME_REFUSAL_MESSAGE, shouldRefuse } from './frame';
import { registerAppServiceWorker } from './pwa/register';
import { initTheme } from './theme/theme';
import './theme/tokens.css';

// The frame check runs before anything renders, so a framed copy never shows the app.
if (shouldRefuse(window)) {
  document.body.textContent = FRAME_REFUSAL_MESSAGE;
} else {
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('index.html has no #root element');
  }
  initTheme();
  // One engine connection per tab. App starts it after the first paint (W3.1).
  const engine = createEngineConnection({ boot: engineBootOptions() });
  // One job worker pool per tab (W3.1 slice 2): it starts no worker until App warms it.
  const jobs = createJobWorkerPool({ start: () => startJobWorker(jobWorkerBootOptions()) });
  createRoot(root).render(
    <StrictMode>
      <App engine={engine} jobs={jobs} startPrintWorker={jobs.acquire} />
    </StrictMode>,
  );
  // Production only: the dev server's modules must not sit behind a service worker cache.
  if (import.meta.env.PROD) {
    void registerAppServiceWorker();
  }
}
