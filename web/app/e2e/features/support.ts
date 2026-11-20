// W8.1 helpers for the feature round trips. A flow opens a generated fixture through the file
// input, saves it through the Save command, and reopens the download in a fresh page. The bytes of
// each saved file go into test-results/host-checks.json (manifest v1), which
// scripts/web_host_verify.py replays with pikepdf and pypdfium2 (W1.7 section 4.2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type TestInfo } from '@playwright/test';

// The engine needs the staged assets (scripts/stage_engine_assets.mjs). Without them a flow cannot
// run, so the specs skip with that reason, as the existing engine specs do.
export const STAGED = existsSync(
  fileURLToPath(new URL('../../public/engine-assets/pyodide.mjs', import.meta.url)),
);

const GENERATED = fileURLToPath(new URL('../../../../tests/fixtures/generated', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../test-results/host-checks.json', import.meta.url));

// A generated fixture (scripts/make_fixtures.py). A missing one fails the test: a skip would hide a
// broken setup, so the message names the script.
export function fixture(name: string): Buffer {
  const path = join(GENERATED, name);
  if (!existsSync(path))
    throw new Error(`fixture ${name} is missing: run scripts/make_fixtures.py`);
  return readFileSync(path);
}

// Collects CSP violations and page errors. The production CSP reports a blocked worker or script to
// the console, so a flow asserts the list is empty at its end.
export function watchPage(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|violates the following/i.test(message.text())) {
      problems.push(message.text());
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

// Opens the app and waits for the engine to report ready (the loading screen goes away).
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
}

// Picks a file through the app's file input and waits for its tab, so the document is open.
export async function openPdf(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer,
  });
  await expect(page.getByRole('tab', { name })).toBeVisible({ timeout: 60_000 });
}

// Counts the dark pixels of one rendered page canvas. A blank canvas gives 0; a page with text
// gives more. The sample is every 17th pixel, which is enough to tell a painted page from a blank.
export async function inkPixels(page: Page, pageIndex: number): Promise<number> {
  return page.evaluate((index) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `[data-page="${index}"] canvas.doc-page-canvas`,
    );
    const context = canvas?.getContext('2d');
    if (!canvas || !context || canvas.width === 0) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let offset = 0; offset < pixels.length; offset += 4 * 17) {
      if (pixels[offset]! < 128) ink += 1;
    }
    return ink;
  }, pageIndex);
}

// Clicks Save and returns the download's name and bytes. Save writes the document as a download
// under its own name (W4.8), so the browser's download event is the file the user gets.
export async function saveDownload(page: Page): Promise<{ name: string; bytes: Buffer }> {
  const save = page.getByRole('button', { name: 'Save', exact: true }).first();
  const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
  const path = await download.path();
  if (!path) throw new Error(`download failed: ${await download.failure()}`);
  return { name: download.suggestedFilename(), bytes: readFileSync(path) };
}

interface ManifestEntry {
  name: string;
  args: string;
  data_b64: string;
  test: string;
}

// Adds one host check for the saved bytes to the manifest. The file is read and written whole, so
// the flows must run one at a time (the features config has one worker).
export function recordHostCheck(
  testInfo: TestInfo,
  name: string,
  data: Buffer,
  args: Record<string, unknown> = {},
): void {
  const manifest: { version: number; checks: ManifestEntry[] } = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
    : { version: 1, checks: [] };
  manifest.checks.push({
    name,
    args: JSON.stringify(args),
    data_b64: data.toString('base64'),
    test: `${testInfo.project.name}: ${testInfo.title}`,
  });
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}
