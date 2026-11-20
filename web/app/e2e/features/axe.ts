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

// A violation a screen still has, excused on one node only: the rule, a part of the node's target
// selector, and the reason with the open decision it waits on (W8.5 S5). Nothing else is excused.
export interface KnownIssue {
  readonly rule: string;
  readonly target: string;
  readonly reason: string;
}

export async function checkAxe(
  page: Page,
  testInfo: TestInfo,
  known: readonly KnownIssue[] = [],
): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const violations = (results.violations as unknown as AxeRule[])
    .map((rule) => ({
      ...rule,
      nodes: rule.nodes.filter(
        (node) =>
          !known.some(
            (k) => k.rule === rule.id && node.target.some((part) => part.includes(k.target)),
          ),
      ),
    }))
    .filter((rule) => rule.nodes.length > 0);
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
