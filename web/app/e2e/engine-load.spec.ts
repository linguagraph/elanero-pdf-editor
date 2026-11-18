// W3.1 browser check: the pinned Pyodide and the PyMuPDF wheel load from our origin under the
// production CSP, in a real Chromium worker. Needs the staged assets (scripts/stage_engine_assets.mjs)
// and the harness page (e2e/harness). Each test boots its own engine in a fresh page.
import { expect, test, type Page, type Worker } from '@playwright/test';
import { CSP_POLICY } from '../src/csp';
import type { BootReport } from './harness/harness';

const WHEEL = /\/pymupdf-[^/]+\.whl$/;
const STAGES = ['pyodide', 'packages', 'engine', 'ready'];

async function openHarness(page: Page): Promise<string[]> {
  // A CSP violation is reported to the console; collect them so a blocked worker or Pyodide fails
  // the test with the exact text.
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|violates the following/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  page.on('pageerror', (error) => violations.push(`pageerror: ${error.message}`));
  await page.goto('/e2e/harness/index.html');
  await page.waitForFunction(() => window.__harness !== undefined);
  return violations;
}

test('the served page carries the production CSP', async ({ page }) => {
  await openHarness(page);
  const content = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(content).toBe(CSP_POLICY);
});

test('the engine loads, reports the stages in order, and answers hello', async ({ page }) => {
  const workers: Worker[] = [];
  page.on('worker', (worker) => workers.push(worker));
  const violations = await openHarness(page);
  const report: BootReport = await page.evaluate(() => window.__harness.bootEngine());
  console.log(`engine ready in ${report.readyMs} ms`);

  expect(report.error, 'engine boot error').toBeUndefined();
  expect(report.stages).toEqual(STAGES);
  expect(report.hello).toEqual({ protocol: 1, engine: expect.any(String), platform: 'web' });
  expect(violations, 'CSP or page errors').toEqual([]);

  // Control for the job worker test: the engine worker keeps fetch.
  const engineWorker = workers.find((worker) => worker.url().startsWith('blob:'));
  expect(engineWorker, 'the engine worker was seen by Playwright').toBeDefined();
  expect(await engineWorker!.evaluate(() => typeof fetch)).toBe('function');
});

test('the job worker loads, answers hello, and has the network globals removed', async ({
  page,
}) => {
  // The job worker removes fetch, XMLHttpRequest, WebSocket and importScripts before the engine
  // stage (jobworker.ts). The worker is read directly after 'ready'; the engine worker is read
  // as the control, since it keeps fetch for the package downloads.
  const workers: Worker[] = [];
  page.on('worker', (worker) => workers.push(worker));
  const violations = await openHarness(page);
  const report: BootReport = await page.evaluate(() => window.__harness.bootJob());
  console.log(`job worker ready in ${report.readyMs} ms`);

  expect(report.error, 'job worker boot error').toBeUndefined();
  expect(report.stages).toEqual(STAGES);
  expect(report.hello).toEqual({ protocol: 1, engine: expect.any(String), platform: 'web' });
  expect(violations, 'CSP or page errors').toEqual([]);

  const jobWorker = workers.find((worker) => worker.url().startsWith('blob:'));
  expect(jobWorker, 'the job worker was seen by Playwright').toBeDefined();
  const globals = await jobWorker!.evaluate(() => ({
    fetch: typeof (globalThis as Record<string, unknown>).fetch,
    XMLHttpRequest: typeof (globalThis as Record<string, unknown>).XMLHttpRequest,
    WebSocket: typeof (globalThis as Record<string, unknown>).WebSocket,
    importScripts: typeof (globalThis as Record<string, unknown>).importScripts,
  }));
  expect(globals, 'job worker globals after ready').toEqual({
    fetch: 'undefined',
    XMLHttpRequest: 'undefined',
    WebSocket: 'undefined',
    importScripts: 'undefined',
  });
  await page.evaluate(() => window.__harness.stopJob());
});

test('a blocked wheel fails the load at the packages stage, without hanging', async ({ page }) => {
  await openHarness(page);
  let blocked = 0;
  await page.route(WHEEL, (route) => {
    blocked += 1;
    return route.abort();
  });
  const report: BootReport = await page.evaluate(() =>
    window.__harness.rawHello(new URL('/engine-assets/', location.href).href),
  );

  expect(blocked, 'the wheel request was made and blocked').toBeGreaterThan(0);
  expect(report.error).toMatchObject({ name: 'EngineLoadError', stage: 'packages' });
  expect(report.stages).toEqual(['pyodide', 'packages']);
  expect(report.readyMs).toBeNull();
});
