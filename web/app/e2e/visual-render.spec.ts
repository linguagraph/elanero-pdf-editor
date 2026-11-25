// W8.2 S3 browser render (docs/web/design/W8.2-visual-golden.md, D1 layer L3): each golden fixture
// opens in the real engine worker, page 1 of each case renders at scale 1.0 through render.page, and
// the RGBA is written as a PNG into test-results/visual/. tests/golden/compare_dir.py then compares
// each PNG with its reference in tests/golden/data (after compositing over white), in web-e2e.yml.
// Chromium only. It needs the staged engine (scripts/stage_engine_assets.mjs) and skips without it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { VisualRender } from './harness/harness';
import { fixture, STAGED, watchPage } from './features/support';

const OUT = fileURLToPath(new URL('../test-results/visual/', import.meta.url));

// The cases of tests/golden/test_golden_render.py that the browser renders, as [fixture, page index].
// sensitive-redacted is left out: its redaction runs in the engine goldens only (the web render
// calls do not apply marks), the same as tests/golden/test_golden_webapi.py.
const CASES: [string, number][] = [
  ['text_multipage', 0],
  ['images', 0],
  ['vector_art', 0],
  ['annotations', 0],
  ['annotations_form', 0],
  ['rotated_pages', 1],
  ['rotated_pages', 4],
  ['rotated_cropped', 1],
  ['rotated_cropped', 6],
  ['cjk_text', 0],
  ['layers', 0],
];

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('each golden fixture renders in the engine worker and is written as a PNG', async ({
    page,
  }) => {
    // One engine boot covers every case, so the run allows for a cold Pyodide load.
    test.setTimeout(10 * 60_000);
    const problems = watchPage(page);
    await page.goto('/e2e/harness/index.html');
    await page.waitForFunction(() => window.__harness !== undefined);
    mkdirSync(OUT, { recursive: true });

    for (const [name, index] of CASES) {
      const pdf = fixture(`${name}.pdf`).toString('base64');
      const rendered: VisualRender = await page.evaluate(
        ({ pdf, name, index }) => window.__harness.renderPng(pdf, name, index),
        { pdf, name: `${name}.pdf`, index },
      );
      expect(rendered.width, `${name} page ${index} has no pixels`).toBeGreaterThan(0);
      writeFileSync(join(OUT, `${name}-p${index}.png`), Buffer.from(rendered.png, 'base64'));
    }

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
