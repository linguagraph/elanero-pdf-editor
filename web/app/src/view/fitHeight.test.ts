import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Fit Page reads the scroll area's clientHeight as the view height. jsdom has no layout, so this
// checks the CSS contract that makes that height the visible one: .app-main (the parent of the
// document view) must have a definite height. With an auto height the view grows to its content,
// clientHeight is the whole document, and Fit Page falls back to the width fit.
function declarations(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start));
}

describe('the document view height', () => {
  it('gives .app-main a definite height so the scroll area is the visible height', () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app.css'),
      'utf8',
    );
    expect(declarations(css, '.app-main')).toMatch(/height:\s*100%/);
  });
});
