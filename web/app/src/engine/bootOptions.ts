// Where the built engine worker and the staged engine assets are (W3.1). The worker's URL comes
// from Vite, so it is the built file in production and the source module under the dev server.
// The assets are the same-origin folder that scripts/stage_engine_assets.mjs fills, next to the
// app's base path. This file is read only by main.tsx, so tests never import the worker URL.
import engineWorkerUrl from './engine.worker.ts?worker&url';
import type { StartOptions } from './start';

export function engineBootOptions(): StartOptions {
  const page = new URL(import.meta.env.BASE_URL, globalThis.location.href);
  return {
    workerUrl: engineWorkerUrl,
    assetBaseUrl: new URL('engine-assets/', page).href,
  };
}

// Where the built job worker is (W3.7). Read only by main.tsx, like the engine's options above.
import jobWorkerUrl from './jobworker.ts?worker&url';

export function jobWorkerBootOptions(): StartOptions {
  const page = new URL(import.meta.env.BASE_URL, globalThis.location.href);
  return {
    workerUrl: jobWorkerUrl,
    assetBaseUrl: new URL('engine-assets/', page).href,
  };
}
