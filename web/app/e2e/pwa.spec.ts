// W4.6 browser check: the built app (the production bundle, served by `vite preview`, so the strict
// CSP applies) registers its service worker, serves its manifest, and after one load keeps working
// offline. The app shell is read from the versioned cache, not from the network.
import { expect, test } from '@playwright/test';

const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:4174/';

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
