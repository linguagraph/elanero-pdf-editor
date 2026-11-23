import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A checked ribbon command (a toggle such as Select or Hand) is a ToggleButton, so react-aria sets
// aria-pressed="true" on it. The stylesheet must mark that state, or the pressed command looks like
// an unpressed one (issue #600). jsdom has no layout, so this reads ribbon.css as text.

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'ribbon.css'), 'utf8');

// The body of the first rule whose selector is exactly `selector` (comments removed first).
function ruleBody(selector: string): string | undefined {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(bare)?.[1];
}

describe('ribbon pressed command style', () => {
  it('sets a background or border for a pressed command', () => {
    const body = ruleBody(".ribbon-command[aria-pressed='true']");
    expect(body, 'a rule for .ribbon-command[aria-pressed=true]').toBeDefined();
    expect(body).toMatch(/\b(background|border|border-color)\s*:/);
  });

  it('keeps the pressed look on hover', () => {
    const body = ruleBody(".ribbon-command[aria-pressed='true']:hover");
    expect(body, 'a hover rule for pressed commands').toBeDefined();
    expect(body).toMatch(/\b(background|border-color)\s*:/);
  });

  it('keeps the disabled rule after the pressed rule, so it still wins', () => {
    const pressedAt = css.indexOf(".ribbon-command[aria-pressed='true'] {");
    const disabledAt = css.indexOf(".ribbon-command[aria-disabled='true'] {");
    expect(pressedAt).toBeGreaterThan(-1);
    expect(disabledAt).toBeGreaterThan(pressedAt);
    expect(ruleBody(".ribbon-command[aria-disabled='true']")).toMatch(/color\s*:/);
  });
});
