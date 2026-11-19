// W3.7 browser check: the job worker answers job.run, so a split job completes in a real browser.
// The harness page runs the app's own split flow (splitJob.ts, fileJob.ts): the engine worker opens
// a three-page PDF, jobs.prepare takes the copy, job.run runs in the job worker, and jobs.apply
// ends the job. The split dialog is not reachable in the app shell yet (the ribbon and the
// document commands come with W4.3a), so the harness calls the same function the dialog calls.
// It needs the staged assets (scripts/stage_engine_assets.mjs, public/engine-assets/).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { SplitReport } from './harness/harness';

const STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

// A three-page PDF. Its objects are numbered and the cross-reference table is written out, so the
// file is well formed and the engine opens it as three pages.
function threePagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
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
  return Buffer.from(text, 'latin1');
}

async function openHarness(page: Page): Promise<string[]> {
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

test.describe('split job', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('a split job completes in the browser and offers its downloads', async ({ page }) => {
    const violations = await openHarness(page);
    const pdf = threePagePdf().toString('base64');
    const report: SplitReport = await page.evaluate(
      (data) => window.__harness.runSplitJob(data, 'three.pdf'),
      pdf,
    );

    expect(report.error, 'split error').toBeUndefined();
    expect(report.files?.map((file) => file.name)).toHaveLength(3);
    for (const file of report.files ?? []) {
      expect(file.mime).toBe('application/pdf');
      expect(file.header).toBe('%PDF-');
      expect(file.size).toBeGreaterThan(0);
    }
    // The bar moved: the job's progress notices reached the page, and the last one is complete.
    expect(report.percents.at(-1)).toBe(100);
    expect(violations, 'CSP or page errors').toEqual([]);
  });
});
