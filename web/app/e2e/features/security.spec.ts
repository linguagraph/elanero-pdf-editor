// W8.6 S6: browser security specs (W1.1 section 10; review findings F4 and G4). The page's CSP must
// be the one in csp.ts and must bind the workers too: a fetch to an origin outside connect-src is
// refused from the page, the engine worker and the job worker. Opening and saving a document makes
// no request to another origin, a link click does not navigate, and the password of a protected file
// reaches neither the storage nor the console.
import { type BrowserContext, type Worker, expect, test } from '@playwright/test';
import { CSP_POLICY } from '../../src/csp';
import { STAGED, fixture, openApp, openPdf, pageSize, saveDownload, watchPage } from './support';

// An origin no connect-src lists. A request that gets past the CSP reaches the route set up below.
const FOREIGN = 'https://example.org/';

// Runs a fetch to FOREIGN and reports the outcome. A refused fetch rejects; 'undefined' means the
// global is gone (the job worker removes fetch, jobworker.ts).
const PROBE = `(async () => {
  if (typeof fetch === 'undefined') return 'undefined';
  try { await fetch(${JSON.stringify(FOREIGN)}); return 'resolved'; } catch { return 'rejected'; }
})()`;

// Every request the context makes (pages, frames and workers share it).
function recordRequests(context: BrowserContext): string[] {
  const urls: string[] = [];
  context.on('request', (request) => urls.push(request.url()));
  return urls;
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('the page carries the production CSP, and the workers are bound by it', async ({
    page,
    context,
  }) => {
    // A request that gets past the CSP is fulfilled here, so a count above 0 is a leak.
    let escaped = 0;
    await context.route(`${FOREIGN}**`, (route) => {
      escaped += 1;
      return route.fulfill({ body: 'escaped' });
    });
    const workers: Worker[] = [];
    page.on('worker', (worker) => workers.push(worker));
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    expect(problems, 'CSP or page errors during engine load and open').toEqual([]);

    // GitHub Pages sends no header, so the meta tag is the only copy of the policy.
    const meta = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(meta).toBe(CSP_POLICY);

    // The engine worker is a blob worker. Its network globals are removed once the engine has
    // booted (engine.worker.ts, lockDownGlobals), so the probe reports 'undefined' there.
    const engine = workers.find((worker) => worker.url().startsWith('blob:'));
    expect(engine, 'the engine worker was seen by Playwright').toBeDefined();
    expect(await engine!.evaluate(PROBE)).toBe('undefined');
    expect(await page.evaluate(PROBE)).toBe('rejected');

    // A job worker starts on save. Its fetch is removed, so the probe reports 'undefined'.
    await saveDownload(page);
    const blobWorkers = workers.filter((worker) => worker.url().startsWith('blob:'));
    for (const worker of blobWorkers) {
      expect(['undefined', 'rejected']).toContain(await worker.evaluate(PROBE));
    }
    expect(escaped, 'requests that escaped the CSP').toBe(0);
    await context.unroute(`${FOREIGN}**`);
  });

  test('a link annotation does not navigate the page on click', async ({ page, context }) => {
    // Current behaviour, asserted exactly: PDF link activation is not built (W5.3 is partial, G5),
    // so a click on a URI link does nothing. The page keeps its URL, no page opens, and no frame
    // navigates. The link is on page 1 of outline.pdf at (72,130)-(200,150) pt.
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'outline.pdf', fixture('outline.pdf'));
    const before = page.url();
    const opened: string[] = [];
    context.on('page', (created) => opened.push(created.url()));
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => navigations.push(frame.url()));

    // A4 is 595 x 842 pt. The link centre is (136, 140) pt, scaled to the page box in CSS pixels.
    const size = await pageSize(page, 0);
    await page
      .locator('[data-page="0"]')
      .click({ position: { x: (136 / 595) * size.width, y: (140 / 842) * size.height } });
    await page.waitForTimeout(500);

    expect(page.url()).toBe(before);
    expect(opened, 'pages opened by the click').toEqual([]);
    expect(navigations, 'frame navigations after the click').toEqual([]);
    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('open and save make no request to another origin', async ({ page, context }) => {
    const requests = recordRequests(context);
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await saveDownload(page);
    expect(problems, 'CSP or page errors').toEqual([]);

    const origin = new URL(page.url()).origin;
    const foreign = requests.filter(
      (url) =>
        !url.startsWith('blob:') && !url.startsWith('data:') && new URL(url).origin !== origin,
    );
    expect(foreign, 'requests to other origins during open and save').toEqual([]);
    expect(requests.length, 'the page made requests at all').toBeGreaterThan(0);
  });

  test('a password is not written to storage or the console', async ({ page }) => {
    // encrypted.pdf (make_fixtures.py) has the user password "user". A short word also appears in
    // ordinary text, so the check flags the password only as a whole word or as a whole value.
    const password = 'user';
    const word = new RegExp(`(^|[^A-Za-z0-9])${password}([^A-Za-z0-9]|$)`);
    const logged: string[] = [];
    page.on('console', (message) => logged.push(message.text()));
    const problems = watchPage(page);
    await openApp(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'encrypted.pdf',
      mimeType: 'application/pdf',
      buffer: fixture('encrypted.pdf'),
    });
    const prompt = page.getByRole('dialog', { name: 'Password required' });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByLabel('Password', { exact: true }).fill(password);
    await prompt.getByRole('button', { name: 'Enter password' }).click();
    await expect(page.getByRole('tab', { name: 'encrypted.pdf' })).toBeVisible({
      timeout: 60_000,
    });

    const stored = await page.evaluate(() => {
      const values: string[] = [];
      for (const area of [window.localStorage, window.sessionStorage]) {
        for (let i = 0; i < area.length; i += 1) {
          const key = area.key(i) ?? '';
          values.push(key, area.getItem(key) ?? '');
        }
      }
      return values;
    });
    const leaks = [...stored, ...logged].filter((text) => text === password || word.test(text));
    expect(leaks, 'storage or console text that holds the password').toEqual([]);
    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
