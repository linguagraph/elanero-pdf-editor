// W8.6 S6: browser security specs (W1.1 section 10; review findings F4 and G4). The page's CSP must
// be the one in csp.ts and must bind the workers too: a fetch to an origin outside connect-src is
// refused from the page, the engine worker and the job worker. Opening and saving a document makes
// no request to another origin, a link click does not navigate, and the password of a protected file
// reaches neither the storage nor the console. A framed copy of the app refuses to start (F10), and
// a PDF with an OpenAction script runs no script on open (F9, browser half only: the engine half is
// not in this change).
import { type BrowserContext, type Worker, expect, test } from '@playwright/test';
import { CSP_POLICY } from '../../src/csp';
import { FRAME_REFUSAL_MESSAGE } from '../../src/frame';
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
    // W5.3 is built: a web link asks first in the "Open link?" dialog (links.spec.ts covers the
    // confirm and the refused kinds). This test pins the no-navigation half: the click shows the
    // dialog and nothing else, so the page keeps its URL, no page opens and no frame navigates.
    // The link is on page 1 of outline.pdf at (72,130)-(200,150) pt.
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
    await expect(page.getByRole('dialog', { name: 'Open link?' })).toBeVisible();
    await page.waitForTimeout(500);

    expect(page.url()).toBe(before);
    expect(opened, 'pages opened by the click').toEqual([]);
    expect(navigations, 'frame navigations after the click').toEqual([]);
    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('a PDF with an OpenAction script runs no script on open', async ({ page, context }) => {
    // sensitive.pdf and xref_gap.pdf carry /OpenAction JavaScript (make_fixtures.py). The engine
    // never hands that script to the browser, so opening them shows no dialog (alert, confirm,
    // prompt), opens no page and logs no error or warning. The rule is observable, not a mechanism.
    // This is a smoke check: the dialog, new-page and console assertions only fire if the browser
    // runs the PDF's script, and no such path exists today, so they can pass trivially. The
    // page.on('console') listener sees only the main page, not messages from the engine worker, and
    // watchPage has the same limit. The strict console check has not been run yet; the first web-e2e
    // run on this branch decides whether a benign-message allowlist is needed.
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      await dialog.dismiss();
    });
    const opened: string[] = [];
    context.on('page', (created) => opened.push(created.url()));
    const logged: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') logged.push(message.text());
    });
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'sensitive.pdf', fixture('sensitive.pdf'));
    await openPdf(page, 'xref_gap.pdf', fixture('xref_gap.pdf'));
    await page.waitForTimeout(500);

    expect(dialogs, 'dialogs raised by a PDF script').toEqual([]);
    expect(opened, 'pages opened by a PDF script').toEqual([]);
    expect(logged, 'console errors or warnings after open').toEqual([]);
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

    // Document properties reads the same file (W7.6 slice D): its Security tab must show the file's
    // facts and keep the password out of storage and the console too. Cancel closes it again.
    await page.getByRole('searchbox', { name: 'Search tools' }).fill('Properties');
    await page.locator('.palette-row[data-command="document-properties"]').click();
    const properties = page.getByRole('dialog', { name: 'Document properties' });
    await expect(properties).toBeVisible();
    await properties.getByRole('tab', { name: 'Security', exact: true }).click();
    await expect(properties.locator('dt:text-is("Printing") + dd')).toHaveText('Allowed');
    await properties.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(properties).toBeHidden();

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

test.describe('frame refusal', () => {
  // Clickjacking (main.tsx, frame.ts): a meta CSP cannot set frame-ancestors, so a framed copy of
  // the app must refuse to start. The host page is served by the route below, on the same origin
  // as the app, so the frame is same-origin. No engine is needed: the check runs before mount.
  test('a framed copy of the app shows the refusal and no app content', async ({ page }) => {
    await page.route('**/frame-host.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><iframe src="/"></iframe></body></html>',
      }),
    );
    await page.goto('/frame-host.html');
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('body')).toHaveText(FRAME_REFUSAL_MESSAGE, { timeout: 60_000 });
    await expect(frame.locator('#root')).toHaveCount(0);
    await expect(frame.locator('.loading-screen')).toHaveCount(0);
  });
});
