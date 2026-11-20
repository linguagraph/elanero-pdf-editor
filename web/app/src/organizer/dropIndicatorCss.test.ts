import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not lay out CSS, so the indicator rules are checked as text: the line must only be
// drawn by the pseudo-element on the side the drop lands on. A rule that matched any [data-drop]
// would also draw the other pseudo-element at its static position, over the thumbnail.
const css = readFileSync(join(__dirname, 'organizer.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function selectorsDrawingTheLine(): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1] ?? '';
    const body = match[2] ?? '';
    if (!/content:\s*''/.test(body)) continue;
    for (const selector of selectors.split(',')) found.push(selector.trim());
  }
  return found.filter((selector) => selector.includes('data-drop'));
}

describe('drop indicator css', () => {
  it('draws the line only on the edge the drop lands on', () => {
    expect(selectorsDrawingTheLine().sort()).toEqual([
      ".organizer-item[data-drop='after']::after",
      ".organizer-item[data-drop='before']::before",
    ]);
  });

  it('keeps the forced-colours colour on the same two selectors', () => {
    const block = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(block).toContain(".organizer-item[data-drop='before']::before");
    expect(block).toContain(".organizer-item[data-drop='after']::after");
    expect(block).not.toMatch(/\[data-drop\]::/);
  });
});
