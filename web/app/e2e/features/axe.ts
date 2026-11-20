// The axe check for the browser screens (W8.5 S3). It runs axe-core through @axe-core/playwright on
// the production build, under the strict CSP, and reports with the same split as the component
// helper (src/test/axe.ts): serious and critical findings fail the test, moderate and minor ones
// are advisories. The full axe JSON is attached to the test, and the advisories go to the GitHub
// step summary when CI runs it.
import { appendFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { classify, type AxeRule } from '../../src/test/axe';

// The WCAG 2.2 AA rule set (W8.5 section 3): every rule these tags select, with no rule switched off.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

export async function checkAxe(page: Page, testInfo: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const violations = results.violations as unknown as AxeRule[];
  const { blocking, advisory } = classify(violations);

  await testInfo.attach('axe-violations.json', {
    body: JSON.stringify(violations, null, 2),
    contentType: 'application/json',
  });
  for (const line of advisory) console.info(`axe advisory ${line}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && advisory.length > 0) {
    const rows = advisory.map((line) => `| ${testInfo.title} | ${line.split('|').join('\\|')} |`);
    appendFileSync(summary, ['', '| Screen | Advisory |', '| --- | --- |', ...rows, ''].join('\n'));
  }
  expect(blocking, 'serious or critical axe violations').toEqual([]);
}
