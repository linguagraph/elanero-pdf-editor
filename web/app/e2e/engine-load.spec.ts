// W3.1 browser check: the pinned Pyodide and the PyMuPDF wheel load from our origin under the
// production CSP, in a real Chromium worker. Needs the staged assets (scripts/stage_engine_assets.mjs)
// and the harness page (e2e/harness). Each test boots its own engine in a fresh page.
import { expect, test, type Page, type Worker } from '@playwright/test';
import { CSP_POLICY } from '../src/csp';
import type { BootReport, PoolCancelReport, PoolReuseReport } from './harness/harness';

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

  // Control for the job worker test: the engine worker loses fetch after boot (W8.6 F1,
  // engine.worker.ts beforeEngine lockDownGlobals), so the control is the post-boot state.
  const engineWorker = workers.find((worker) => worker.url().startsWith('blob:'));
  expect(engineWorker, 'the engine worker was seen by Playwright').toBeDefined();
  expect(await engineWorker!.evaluate(() => typeof fetch)).toBe('undefined');
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

// A one-page PDF, written out with its cross-reference table, so the engine opens it as one page.
function onePagePdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj ${body} endobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, 'latin1').toString('base64');
}

test('the job pool reuses one job worker for two jobs, and the reused worker stays locked down', async ({
  page,
}) => {
  const workers: Worker[] = [];
  page.on('worker', (worker) => workers.push(worker));
  const violations = await openHarness(page);
  const report: PoolReuseReport = await page.evaluate(
    (data) => window.__harness.poolReuse(data, 'one.pdf'),
    onePagePdf(),
  );

  expect(report.error, 'pool job error').toBeUndefined();
  expect(report.files).toEqual([1, 1]);
  // The pool counts its own starts: one job worker served both jobs.
  expect(report.started, 'job workers the pool started for two jobs').toBe(1);
  // Two blob: workers in total: the engine worker and that one job worker. Each one locks down
  // its globals (engine.worker.ts and jobworker.ts both call lockDownGlobals), so each has no
  // fetch, XMLHttpRequest, WebSocket or importScripts.
  const blobWorkers = workers.filter((item) => item.url().startsWith('blob:'));
  expect(blobWorkers, 'blob workers: the engine worker and one job worker').toHaveLength(2);
  for (const worker of blobWorkers) {
    const globals = await worker.evaluate(() => ({
      fetch: typeof (globalThis as Record<string, unknown>).fetch,
      XMLHttpRequest: typeof (globalThis as Record<string, unknown>).XMLHttpRequest,
      WebSocket: typeof (globalThis as Record<string, unknown>).WebSocket,
      importScripts: typeof (globalThis as Record<string, unknown>).importScripts,
    }));
    expect(globals, 'worker globals after lockdown').toEqual({
      fetch: 'undefined',
      XMLHttpRequest: 'undefined',
      WebSocket: 'undefined',
      importScripts: 'undefined',
    });
  }
  await page.evaluate(() => window.__harness.poolStop());
  expect(violations, 'CSP or page errors').toEqual([]);
});

test('cancelling a job discards its worker, and a new one starts in the background', async ({
  page,
}) => {
  const workers: Worker[] = [];
  page.on('worker', (worker) => workers.push(worker));
  const violations = await openHarness(page);
  const report: PoolCancelReport = await page.evaluate(() => window.__harness.poolCancel());

  expect(report.error, 'pool cancel error').toBeUndefined();
  expect(report.hello).toEqual({ protocol: 1, engine: expect.any(String), platform: 'web' });
  // One worker for the cancelled job and one for the re-warm after it. The event for the second
  // worker can arrive a moment after the reply, so the count is polled.
  await expect.poll(() => workers.filter((item) => item.url().startsWith('blob:')).length).toBe(2);
  await page.evaluate(() => window.__harness.poolStop());
  expect(violations, 'CSP or page errors').toEqual([]);
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
