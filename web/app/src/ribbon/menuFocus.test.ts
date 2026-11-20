// W8.5 S4: the app menu's keyboard position must have a visible ring. The item removes the browser
// outline (react-aria marks the item with data-focused), so the ring is its own rule on
// [data-focus-visible]. jsdom has no layout, so this reads the stylesheet, as forced-colours does.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'ribbon.css'), 'utf8');

// The declarations of the rule whose selector is exactly `selector`.
function declarationsOf(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('app menu focus', () => {
  it('the item hides the browser outline only because a ring replaces it', () => {
    expect(declarationsOf('.app-menu-item')).toMatch(/outline:\s*none/);
    const ring = declarationsOf('.app-menu-item[data-focus-visible]');
    expect(ring).toMatch(/outline:\s*2px solid var\(--color-focus-ring\)/);
    expect(ring).toMatch(/outline-offset:\s*-2px/);
  });
});
