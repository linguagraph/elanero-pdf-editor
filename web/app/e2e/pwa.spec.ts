// W4.6 browser check: the built app (the production bundle, served by `vite preview`, so the strict
// CSP applies) registers its service worker, serves its manifest, and after one load keeps working
// offline. The app shell is read from the versioned cache, not from the network.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:4174/';

// The engine assets are staged by scripts/stage_engine_assets.mjs; without them the engine cannot
// start and this block is skipped, as in open-during-load.spec.ts. CI does not stage them yet
// (W9.1/W9.2), so this runs locally only.
const STAGED_DIR = new URL('../public/engine-assets/', import.meta.url);
const STAGED = existsSync(fileURLToPath(new URL('pyodide.mjs', STAGED_DIR)));

// The engine files the build precaches: core, packages, the wheel and the web zip.
function stagedEngineFiles(): string[] {
  const stage = JSON.parse(
    readFileSync(fileURLToPath(new URL('stage-manifest.json', STAGED_DIR)), 'utf8'),
  ) as {
    core: string[];
    packages: { file: string }[];
    wheel: { file: string };
    web: { file: string };
  };
  return [
    ...stage.core,
    ...stage.packages.map((pkg) => pkg.file),
    stage.wheel.file,
    stage.web.file,
  ].map((file) => `engine-assets/${file}`);
}

// A one-page PDF, as in open-during-load.spec.ts.
function pdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
      'trailer << /Root 1 0 R >>\n%%EOF\n',
  );
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('every staged engine file is cached, and the engine starts and opens a PDF offline', async ({
    page,
    context,
  }) => {
    await page.goto(APP_URL);
    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    // The one versioned cache holds every staged file, under the URL the engine fetches it by.
    const cache = await page.evaluate(async (paths: string[]) => {
      const names = (await caches.keys()).filter((name) => name.startsWith('elanero-'));
      const first = names[0];
      if (names.length !== 1 || first === undefined)
        return { caches: names.length, missing: paths };
      const store = await caches.open(first);
      const missing: string[] = [];
      for (const path of paths) {
        if ((await store.match(new URL(path, location.href).href)) === undefined)
          missing.push(path);
      }
      return { caches: names.length, missing };
    }, stagedEngineFiles());
    expect(cache.caches).toBe(1);
    expect(cache.missing).toEqual([]);

    // Offline: any network request for the engine would fail, so the reload proves the engine
    // starts from the cache alone (W0.2: no network request before page 1).
    await context.setOffline(true);
    try {
      const started = Date.now();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Elanero could not start' })).toHaveCount(0);
      await page.locator('input[type="file"]').setInputFiles({
        name: 'offline.pdf',
        mimeType: 'application/pdf',
        buffer: pdf(),
      });
      await expect(page.getByRole('tab', { name: /offline\.pdf/ })).toBeVisible({
        timeout: 180_000,
      });
      // Recorded, not asserted: the warm boot time for W8.3.
      test.info().annotations.push({
        type: 'warm boot (offline, from cache)',
        description: `${Date.now() - started} ms to a PDF tab`,
      });
    } finally {
      await context.setOffline(false);
    }
  });
});

test('the service worker registers, the manifest is served, and the app works offline after one load', async ({
  page,
  context,
}) => {
  await page.goto(APP_URL);
  await expect(page.locator('h1')).toHaveText('Elanero');

  // The manifest is linked from the page and served as a web app manifest.
  const manifestUrl = await page
    .locator('link[rel="manifest"]')
    .evaluate((link) => (link as HTMLLinkElement).href);
  const manifest = await page.request.get(manifestUrl);
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as { name: string; display: string };
  expect(body.name).toBe('Elanero');
  expect(body.display).toBe('standalone');

  // The worker is active, and it has claimed this page (the first load is not yet controlled).
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // One load after install: the app shell and the bundle are in the versioned cache.
  const cacheNames = await page.evaluate(() => caches.keys());
  const versioned = cacheNames.filter((name) => name.startsWith('elanero-'));
  expect(versioned).toHaveLength(1);
  const versionedName = versioned[0];
  if (versionedName === undefined) throw new Error('no versioned cache was created');
  const cached = await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const script = document.querySelector('script[type="module"]') as HTMLScriptElement | null;
    const shell = await cache.match(new URL('index.html', location.href).href);
    const bundle = script ? await cache.match(script.src) : undefined;
    return { shell: shell !== undefined, bundle: bundle !== undefined };
  }, versionedName);
  expect(cached).toEqual({ shell: true, bundle: true });

  // Offline reload: the page comes from the cache.
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.locator('h1')).toHaveText('Elanero');
  } finally {
    await context.setOffline(false);
  }
});
