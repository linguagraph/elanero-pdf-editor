// W8.3 S3: the browser performance harness, run against the production build (vite preview). It
// records W2 (repeat visit to page 1 painted), W3 (cold first visit, trend), W7 (longest main-thread
// task while scrolling end to end) and W8 (time to a sharp page after scrolling stops, trend), and
// writes perf-results.json (docs/web/design/W8.3-performance.md, sections 2.1 and 2.5). It asserts
// no limit: the paired comparison and the gates are S4's job. W4, W5, W6 and W9 are not measured
// yet. Chromium only (design 2.2, item 5). It skips, with a message, when the engine assets are not
// staged or the perf_mixed fixtures are not generated (scripts/make_fixtures.py).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

// The perf config serves the production build on its own port (playwright.perf.config.ts).
test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4176' });

const ENGINE_STAGED = existsSync(
  fileURLToPath(new URL('../../public/engine-assets/pyodide.mjs', import.meta.url)),
);
const FIXTURE_DIR = fileURLToPath(
  new URL('../../../../tests/fixtures/generated/', import.meta.url),
);
const OUT_FILE =
  process.env.PERF_OUT ??
  fileURLToPath(new URL('../../test-results/perf/perf-results.json', import.meta.url));
const SMALL = 'perf_mixed_10.pdf';
const LARGE = 'perf_mixed_1000.pdf';
const LARGE_PAGES = 1000;

// Runs per metric (design 2.2, item 1). Run 0 is the process warm-up: it is dropped from the repeat
// and scroll samples, and kept for the cold samples, where cold is the point.
const RUNS = parseRuns(process.env.PERF_RUNS ?? '5');
const LOAD_TIMEOUT_MS = 180_000;
const SCROLL_STEPS = 50;
const STEP_PAUSE_MS = 100;
const VIEWPORT = { width: 1280, height: 800 };

interface Mark {
  name: string;
  startTime: number;
}

interface PerfRecord {
  id: string;
  unit: 'ms';
  fixture: string;
  samples: number[];
  median: number;
  marks?: Mark[];
}

const records: PerfRecord[] = [];

// PERF_RUNS is the number of measured runs. A value that is not a positive integer would give an
// empty sample set and a NaN median, so it fails here, with the value named.
function parseRuns(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`PERF_RUNS must be a positive integer, got "${raw}"`);
  }
  return value;
}

test.afterAll(() => {
  if (records.length === 0) return;
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  const body = {
    schema: 1,
    commit: process.env.GITHUB_SHA ?? 'local',
    // ImageOS-ImageVersion, as the desktop harness writes it (tests/benchmarks/conftest.py).
    runner: process.env.ImageOS
      ? [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join('-')
      : process.platform,
    date: new Date().toISOString().slice(0, 10),
    // web-perf.yml sets PERF_ATTEMPT per attempt (1 or 2); a local run is attempt 1.
    attempt: Number(process.env.PERF_ATTEMPT ?? '1'),
    records,
  };
  writeFileSync(OUT_FILE, JSON.stringify(body, null, 2));
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function record(id: string, fixture: string, samples: number[], marks?: Mark[]): void {
  const rounded = samples.map((value) => Math.round(value));
  records.push({
    id,
    unit: 'ms',
    fixture,
    samples: rounded,
    median: Math.round(median(rounded)),
    marks,
  });
}

// The start page's file input takes the file while the engine is still loading (W3.1), so the
// timed window covers the load, the open and the first paint.
async function openDocument(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.locator('.doc-page').first()).toBeAttached({ timeout: LOAD_TIMEOUT_MS });
}

// True when the page has a canvas with a pixel that is not white (as long-document.spec.ts).
function hasInk(page: Page, pageNumber: number): Promise<boolean> {
  return page.evaluate((n) => {
    const host = document.querySelector(`.doc-page[data-page="${n - 1}"]`);
    if (host === null) return false;
    for (const canvas of host.querySelectorAll('canvas')) {
      if (canvas.width === 0 || canvas.height === 0) continue;
      const ctx = canvas.getContext('2d');
      if (ctx === null) continue;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 255;
        const g = data[i + 1] ?? 255;
        const b = data[i + 2] ?? 255;
        const a = data[i + 3] ?? 0;
        if (a > 0 && (r < 250 || g < 250 || b < 250)) return true;
      }
    }
    return false;
  }, pageNumber);
}

async function expectInk(page: Page, pageNumber: number): Promise<void> {
  await expect
    .poll(() => hasInk(page, pageNumber), { timeout: LOAD_TIMEOUT_MS, intervals: [200] })
    .toBe(true);
}

// "Sharp": the page has ink, and every canvas of its host is at the device size of its box (the
// backing width and height match the CSS box times devicePixelRatio, within 3%, one scale step of
// quantizeScale). A page drawn at another scale, or not yet drawn, is not sharp.
function isSharp(page: Page, pageNumber: number): Promise<boolean> {
  return page.evaluate((n) => {
    const host = document.querySelector(`.doc-page[data-page="${n - 1}"]`);
    if (host === null) return false;
    const canvases = [...host.querySelectorAll('canvas')];
    if (canvases.length === 0) return false;
    const dpr = window.devicePixelRatio;
    const close = (actual: number, css: number): boolean => {
      const expected = css * dpr;
      return actual > 0 && Math.abs(actual - expected) <= Math.max(2, expected * 0.03);
    };
    // drawn is set by drawPixels (view/pixels.tsx) after each draw, so an undrawn canvas fails here.
    return canvases.every((canvas) => {
      const box = canvas.getBoundingClientRect();
      return (
        canvas.dataset.drawn === 'true' &&
        close(canvas.width, box.width) &&
        close(canvas.height, box.height)
      );
    });
  }, pageNumber);
}

async function expectSharp(page: Page, pageNumber: number): Promise<void> {
  await expect
    .poll(async () => (await isSharp(page, pageNumber)) && (await hasInk(page, pageNumber)), {
      timeout: LOAD_TIMEOUT_MS,
      intervals: [200],
    })
    .toBe(true);
}

// Scrolls the pages to a fraction of their extent (1 is the last page).
async function scrollTo(page: Page, fraction: number): Promise<void> {
  await page.locator('.doc-view-scroll').evaluate((el, f) => {
    const scroller = el as HTMLElement;
    scroller.scrollTop = f >= 1 ? scroller.scrollHeight : scroller.scrollHeight * f;
  }, fraction);
}

// The load-stage marks the app set (src/perf/marks.ts), read from the current document.
function loadMarks(page: Page): Promise<Mark[]> {
  return page.evaluate(() =>
    performance
      .getEntriesByType('mark')
      .filter((entry) => entry.name.startsWith('elanero:load:'))
      .map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) })),
  );
}

// Records each long task of the page; the scroll test reads the worst one of each run.
function longTaskInit(): void {
  const w = window as unknown as { __longTasks: number[] };
  w.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) w.__longTasks.push(entry.duration);
  }).observe({ type: 'longtask', buffered: true });
}

test.describe('engine staged', () => {
  test.skip(
    !ENGINE_STAGED,
    'engine assets are not staged (scripts/stage_engine_assets.mjs); perf not run',
  );

  test('a 10-page document: cold and repeat visits (W2, W3)', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      !existsSync(FIXTURE_DIR + SMALL),
      `${SMALL} is not generated (scripts/make_fixtures.py)`,
    );
    test.setTimeout(60 * 60_000);
    const bytes = readFileSync(FIXTURE_DIR + SMALL);
    const cold: number[] = [];
    const repeat: number[] = [];
    let marks: Mark[] = [];

    for (let run = 0; run <= RUNS; run++) {
      // A new context per run: the first load really starts with an empty cache.
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      const started = Date.now();
      await page.goto('/');
      await openDocument(page, SMALL, bytes);
      await expectInk(page, 1);
      cold.push(Date.now() - started);

      // The repeat visit reloads in the same context, so the wheel and the bundle come from cache.
      await page.reload();
      const again = Date.now();
      await openDocument(page, SMALL, bytes);
      await expectInk(page, 1);
      if (run > 0) repeat.push(Date.now() - again);
      marks = await loadMarks(page);
      await context.close();
    }

    record('W2', SMALL, repeat, marks);
    record('W3', SMALL, cold);
  });

  test('a 1000-page document: longest task and sharp page after scrolling (W7, W8)', async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.skip(
      !existsSync(FIXTURE_DIR + LARGE),
      `${LARGE} is not generated (scripts/make_fixtures.py)`,
    );
    test.setTimeout(3 * 60 * 60_000);
    const bytes = readFileSync(FIXTURE_DIR + LARGE);
    const worstTasks: number[] = [];
    const sharp: number[] = [];

    for (let run = 0; run <= RUNS; run++) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      await context.addInitScript(longTaskInit);
      const page = await context.newPage();
      await page.goto('/');
      await openDocument(page, LARGE, bytes);
      await expectInk(page, 1);

      await page.evaluate(() => {
        (window as unknown as { __longTasks: number[] }).__longTasks = [];
      });
      // End to end, in steps, with a pause for the page to draw each step.
      for (let step = 1; step <= SCROLL_STEPS; step++) {
        await scrollTo(page, step / SCROLL_STEPS);
        await page.waitForTimeout(STEP_PAUSE_MS);
      }
      const stopped = Date.now();
      // Read before the sharpness check: its pixel scan runs in the page and must not count as W7.
      const worst = await page.evaluate(() => {
        const tasks = (window as unknown as { __longTasks: number[] }).__longTasks;
        return tasks.reduce((max, duration) => Math.max(max, duration), 0);
      });
      await expectSharp(page, LARGE_PAGES);
      if (run > 0) {
        worstTasks.push(worst);
        sharp.push(Date.now() - stopped);
      }
      await context.close();
    }

    record('W7', LARGE, worstTasks);
    record('W8', LARGE, sharp);
  });
});
