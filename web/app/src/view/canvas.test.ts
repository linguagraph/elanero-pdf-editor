import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The canvas classes (W1.6 section 4, U4): the canvas is the token colour, the page column is
// centred, and each page carries a soft shadow. A class and declaration check, not a pixel check.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'documentView.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('document canvas', () => {
  it('paints the canvas with the token colour', () => {
    expect(rule('.doc-view-scroll')).toContain('background: var(--color-canvas);');
  });

  it('centres the page column in the canvas', () => {
    expect(rule('.doc-view-content')).toContain('margin: 0 auto;');
  });

  it('gives each page a soft drop shadow', () => {
    expect(rule('.doc-page')).toContain('box-shadow:');
  });

  it('renders the pages with the classes the rules use', () => {
    const view = readFileSync(resolve(here, 'DocumentView.tsx'), 'utf8');
    expect(view).toContain('className="doc-view-content"');
    expect(view).toContain('className="doc-page"');
  });
});
