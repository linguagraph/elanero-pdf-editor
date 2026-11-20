// W8.1 S1: the first feature round trip. A five-page fixture opens and renders, Save writes it
// as a download, and the download reopens in a fresh page with its pages painted. The saved bytes
// are recorded for the host replay (pikepdf opens it, pdfium counts five pages).
import { expect, test } from '@playwright/test';
import {
  STAGED,
  fixture,
  inkPixels,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('open, view, save, and reopen the saved file', async ({ page, context }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    // View: the document reports its page count, and page 1 is painted.
    await expect(page.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();
    await expect.poll(() => inkPixels(page, 0)).toBeGreaterThan(0);

    // Save: the download keeps the document's name and is the file the user gets.
    const saved = await saveDownload(page);
    expect(saved.name).toBe('text_multipage.pdf');
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Reopen the saved bytes in a fresh page, so nothing from the first session carries over.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await expect(reopened.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();
    await expect.poll(() => inkPixels(reopened, 0)).toBeGreaterThan(0);

    recordHostCheck(testInfo, 'opens_pikepdf', saved.bytes);
    recordHostCheck(testInfo, 'page_count_pdfium', saved.bytes, { pages: 5 });
    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });
});
