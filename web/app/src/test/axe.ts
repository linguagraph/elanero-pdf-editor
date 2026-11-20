import axe from 'axe-core';

// The axe check for component tests (W8.5 S1). It calls axe-core directly: a wrapper library
// would add a dependency for thirty lines of code. Only serious and critical findings block a test
// (W1.7 section 10); moderate and minor ones are returned as advisories for the report.

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

export interface AxeReport {
  // One line per blocking node, in the form the W8.5 check reports: rule, impact, target and HTML.
  blocking: string[];
  advisory: string[];
}

// Rules that describe a whole page, which a component rendered into jsdom does not have.
// `region` and `landmark-*` apply to a page's landmarks, `document-title`, `html-has-lang` and
// `page-has-heading-one` to the document, and `bypass` to the skip link in the app shell.
// `color-contrast` and `target-size` need layout and computed colours, which jsdom does not
// compute: contrast is checked at the source (W8.5 S2) and in the browser (S3, S5).
const JSDOM_DISABLED_RULES = [
  'region',
  'landmark-one-main',
  'page-has-heading-one',
  'document-title',
  'html-has-lang',
  'bypass',
  'color-contrast',
  'target-size',
];

const BLOCKING: readonly Impact[] = ['serious', 'critical'];
const MAX_HTML = 160;

interface AxeNode {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface AxeRule {
  id: string;
  impact?: Impact | null;
  help: string;
  nodes: AxeNode[];
}

function lines(rule: AxeRule): string[] {
  const impact = rule.impact ?? 'minor';
  return rule.nodes.map((node) => {
    const html = node.html.length > MAX_HTML ? `${node.html.slice(0, MAX_HTML)}...` : node.html;
    const fix = node.failureSummary ? ` ${node.failureSummary.replace(/\s+/g, ' ').trim()}` : '';
    return `[${impact}] ${rule.id}: ${node.target.join(' ')} ${html} "${rule.help}"${fix}`;
  });
}

// Splits axe's violations into the lines that block a test and the advisories for the report. The
// browser check (W8.5 S3) uses the same split, so both fail on the same findings.
export function classify(violations: AxeRule[]): AxeReport {
  const blocking: string[] = [];
  const advisory: string[] = [];
  for (const rule of violations) {
    const impact = rule.impact ?? 'minor';
    if (BLOCKING.includes(impact)) {
      blocking.push(...lines(rule));
    } else {
      // One short line per node: rule, impact and the first target. The full HTML is only needed
      // for a blocking failure, so the console report stays readable.
      for (const node of rule.nodes) {
        advisory.push(`[${impact}] ${rule.id}: ${String(node.target[0] ?? '(no target)')}`);
      }
    }
  }
  return { blocking, advisory };
}

// Runs axe over the subtree of `context` (or the whole body, for portalled dialogs).
export async function runAxe(context: Element = document.body): Promise<AxeReport> {
  const rules: Record<string, { enabled: false }> = {};
  for (const id of JSDOM_DISABLED_RULES) rules[id] = { enabled: false };
  const results = (await axe.run(context, { rules, resultTypes: ['violations'] })) as unknown as {
    violations: AxeRule[];
  };
  return classify(results.violations);
}
