// Pure helpers for the PWA (W4.6), shared by the build (vite.config.ts) and the tests. Nothing here
// touches the DOM or Node, so the same functions run in both. The build reads the output folder,
// hashes each file, and writes the result into the service worker; these functions decide the
// shape of that result.
import { PYMUPDF_WHEEL_FILE, WEB_ZIP_FILE } from '../engine/pins.ts';
import { BRAND, COLOURS } from '../theme/tokens.ts';

export interface PrecacheFile {
  // Path relative to the app's folder (the service worker's scope), with forward slashes.
  path: string;
  // Lower-case hex SHA-256 of the file's bytes, checked by the service worker before caching.
  sha256: string;
}

export interface ServiceWorkerBuild {
  cacheName: string;
  // The commit the build was made from, for diagnostics only; it is not part of the cache name.
  commit: string;
  files: readonly PrecacheFile[];
}

// Placeholder in public/sw.js. The build replaces it with the JSON of a ServiceWorkerBuild.
export const BUILD_PLACEHOLDER = '__BUILD_JSON__';

// Every cache this app creates starts with this, so the service worker can find and delete the
// caches of older versions without touching anything else on the origin.
export const CACHE_PREFIX = 'elanero-';

// The versioned name: the app version plus a build id. The build id is derived from the content
// of the files (see buildIdSource), so any changed file gives a new cache, even when the commit is
// unknown or the working tree has uncommitted changes.
export function appCacheName(version: string, buildId: string): string {
  if (!/^[\w.-]+$/.test(version) || !/^[0-9a-f]+$/.test(buildId)) {
    throw new Error(`invalid cache name parts: ${version} ${buildId}`);
  }
  return `${CACHE_PREFIX}${version}-${buildId}`;
}

// The text whose hash is the build id: one "path sha256" line per file, sorted by path, so the
// order of the directory walk does not matter.
export function buildIdSource(files: readonly PrecacheFile[]): string {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path} ${file.sha256}\n`)
    .join('');
}

// The web app manifest. Its URLs are relative, so the same file works under any deployment base
// path (the app is served under /elanero-pdf-editor/app/ on GitHub Pages, W9.2). The colours come
// from the design tokens, the same ones the page uses in light mode.
export function buildManifest(): Record<string, unknown> {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    theme_color: COLOURS.light.brand,
    background_color: COLOURS.light.window,
    icons: [
      { src: 'icons/elanero-256.png', sizes: '256x256', type: 'image/png' },
      { src: 'icons/elanero-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
    // "Open with" for PDFs (W4.6 S1). The action is the start URL, so it is in scope under any base
    // path and the service worker serves the shell for it. The file arrives through launchQueue,
    // never in the URL. Only PDF is accepted.
    file_handlers: [
      {
        action: './',
        accept: { 'application/pdf': ['.pdf'] },
        icons: [{ src: 'icons/elanero-256.png', sizes: '256x256', type: 'image/png' }],
        // Several files picked together arrive as one launch, in one window (the app has tabs).
        launch_type: 'single-client',
      },
    ],
    // An open window gets the launch through its launchQueue, without a reload that would lose
    // unsaved work. "auto" is the fallback where focus-existing is not supported.
    launch_handler: { client_mode: ['focus-existing', 'auto'] },
  };
}

// Writes the build into the service worker source. It fails when the placeholder is missing, so a
// change to public/sw.js that drops it cannot ship an unversioned worker.
export function renderServiceWorker(source: string, build: ServiceWorkerBuild): string {
  if (!source.includes(BUILD_PLACEHOLDER)) {
    throw new Error(`the service worker source has no ${BUILD_PLACEHOLDER} placeholder`);
  }
  // The placeholder sits inside a single-quoted JavaScript string, so the JSON must be escaped
  // for that context.
  const json = JSON.stringify(build).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return source.replace(BUILD_PLACEHOLDER, json);
}

// The file stage_engine_assets.mjs writes into public/engine-assets (and so into dist/). Only the
// wheel, the web zip and the packages carry a SHA-256 there; the core files are checked by name.
export interface StageManifest {
  pyodide: string;
  core: readonly string[];
  packages: readonly { name: string; version: string; file: string; sha256: string }[];
  wheel: { file: string; bytes: number; sha256: string };
  web?: { file: string; sha256: string };
}

// The folder under the build output where the staged engine files are served from.
export const ENGINE_DIR = 'engine-assets';
export const STAGE_MANIFEST_FILE = 'stage-manifest.json';

// Compares the precache list with the staged engine files (W4.6 S2). The engine fetches these
// files by name, so a file missing from the list is not available offline, and a SHA-256 that
// differs from the stage manifest means the build did not stage what the manifest describes. Each
// problem names its file. An empty result means the build is consistent.
export function engineAssetProblems(
  files: readonly PrecacheFile[],
  stage: StageManifest,
): string[] {
  const precached = new Map(files.map((file) => [file.path, file.sha256]));
  const problems: string[] = [];
  const expect = (file: string, sha256?: string): void => {
    const path = `${ENGINE_DIR}/${file}`;
    const actual = precached.get(path);
    if (actual === undefined) {
      problems.push(`${path} is staged but not in the precache list`);
    } else if (sha256 !== undefined && actual !== sha256) {
      problems.push(
        `${path} is in the precache list with a SHA-256 other than stage-manifest.json`,
      );
    }
  };
  for (const file of stage.core) expect(file);
  for (const pkg of stage.packages) expect(pkg.file, pkg.sha256);
  if (stage.wheel.file !== PYMUPDF_WHEEL_FILE) {
    problems.push(`the staged wheel ${stage.wheel.file} is not the pinned ${PYMUPDF_WHEEL_FILE}`);
  }
  expect(stage.wheel.file, stage.wheel.sha256);
  if (stage.web?.file !== WEB_ZIP_FILE) {
    problems.push(`stage-manifest.json does not name ${WEB_ZIP_FILE}`);
  } else {
    expect(stage.web.file, stage.web.sha256);
  }
  return problems;
}
