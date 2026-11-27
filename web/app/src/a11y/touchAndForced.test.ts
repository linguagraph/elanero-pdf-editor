import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOUCH_TARGET_PX } from '../theme/tokens.ts';

// The touch-target and forced-colour checks of the document view (W8.5 S5). jsdom has no layout, so
// these read the stylesheets as text: each control's size under `pointer: coarse` must be at least
// 44 px (W1.6 section 8), and no forced-colours rule may remove the border or outline that marks a
// selected tab or a control. The browser run (e2e/features/document.spec.ts) checks the rendered sizes.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');

function read(path: string): string {
  return readFileSync(resolve(SRC, path), 'utf8');
}

// Every .css file under src, with its path relative to src.
function allStylesheets(dir = SRC, base = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...allStylesheets(full, rel));
    else if (name.endsWith('.css')) out.push([rel, readFileSync(full, 'utf8')]);
  }
  return out;
}

// The body of each block that opens with `header` (for example "@media (pointer: coarse) {"), found
// by brace depth so nested rules are kept. Returns the text between the braces of each match.
function blocksOf(css: string, header: string): string[] {
  const blocks: string[] = [];
  let at = css.indexOf(header);
  while (at > -1) {
    let depth = 1;
    let i = at + header.length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    blocks.push(css.slice(at + header.length, i - 1));
    at = css.indexOf(header, i);
  }
  return blocks;
}

// The declarations of each selector rule in a block, as a map from selector to "prop: value" pairs.
function rulesIn(block: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  // Comments go first, so a comment above a rule is not read as part of its selector.
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').trim().split(/\s*,\s*/);
    const decls = new Map<string, string>();
    for (const decl of (match[2] ?? '').split(';')) {
      const colon = decl.indexOf(':');
      if (colon > -1) decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
    for (const selector of selectors) {
      rules.set(selector, new Map([...(rules.get(selector) ?? []), ...decls]));
    }
  }
  return rules;
}

// A size written as `var(--size-touch-target)` resolves to the token, so the rules that use it are
// checked against the same number the token holds (tokens.ts, W8.5 S7).
function px(value: string | undefined): number {
  if (value === 'var(--size-touch-target)') return TOUCH_TARGET_PX;
  return value ? parseFloat(value) : 0;
}

// The controls the brief lists, with the sizes their coarse rule must set.
const COARSE_TARGETS: Array<[file: string, selector: string, props: string[]]> = [
  ['view/documentView.css', '.doc-status-controls button', ['min-width', 'min-height']],
  ['view/documentView.css', '.doc-status-controls input', ['min-width', 'min-height']],
  ['tabs/tabs.css', '.doc-tab', ['min-height']],
  ['tabs/tabs.css', '.doc-tab-close', ['width', 'height']],
  ['tabs/tabs.css', '.doc-strip-open', ['min-width', 'min-height']],
  ['ribbon/ribbon.css', '.ribbon-command', ['min-width', 'min-height']],
  ['ribbon/ribbon.css', '.ribbon-tab', ['min-width', 'min-height']],
  ['ribbon/ribbon.css', '.app-menu-item', ['min-height']],
  ['edit/edit.css', '.edit-style-bar button', ['min-width', 'min-height']],
  ['edit/edit.css', '.edit-style-bar input', ['min-width', 'min-height']],
  ['edit/edit.css', '.edit-style-bar select', ['min-width', 'min-height']],
  ['edit/edit.css', '.edit-font-option', ['min-width', 'min-height']],
  ['theme/ThemeSwitch.css', '.theme-switch-option', ['min-width', 'min-height']],
  ['app.css', '.update-banner button', ['min-width', 'min-height']],
  ['combine/combine.css', '.combine-pages input', ['min-width', 'min-height']],
  ['combine/combine.css', '.combine-button', ['min-width', 'min-height']],
  ['properties/properties.css', '.properties-field input', ['min-width', 'min-height']],
  ['properties/properties.css', '.properties-button', ['min-width', 'min-height']],
  ['properties/properties.css', '.properties-tab', ['min-width', 'min-height']],
  ['security/security.css', '.security-field input', ['min-width', 'min-height']],
  ['security/security.css', '.security-field select', ['min-width', 'min-height']],
  ['security/security.css', '.security-check', ['min-width', 'min-height']],
  ['layout/layout.css', '.overlay-close', ['min-width', 'min-height']],
  ['feedback/feedback.css', '.feedback-primary', ['min-width', 'min-height']],
  ['translate/translate.css', '.translate-bubble button', ['min-width', 'min-height']],
  ['translate/translate.css', '.translate-bubble select', ['min-width', 'min-height']],
];

describe('touch targets under pointer: coarse', () => {
  for (const [file, selector, props] of COARSE_TARGETS) {
    it(`${selector} is at least 44 px in ${file}`, () => {
      const blocks = blocksOf(read(file), '@media (pointer: coarse) {');
      expect(blocks.length, `${file} has a pointer: coarse block`).toBeGreaterThan(0);
      const rules = blocks.map(rulesIn);
      for (const prop of props) {
        const values = rules.map((rule) => px(rule.get(selector)?.get(prop)));
        expect(
          Math.max(...values),
          `${file}: ${selector} ${prop} under pointer: coarse`,
        ).toBeGreaterThanOrEqual(44);
      }
    });
  }
});

describe('forced colours keep the marks of a selected or pressed control', () => {
  it('the selected document tab keeps a solid top border, so it stays marked', () => {
    const rules = rulesIn(read('tabs/tabs.css'));
    const selected = rules.get(".doc-tab[aria-selected='true']");
    const base = rules.get('.doc-tab');
    // The 2 px top edge is on every tab (transparent unless selected); forced colours keep its style.
    expect(base?.get('border-top')).toMatch(/2px solid/);
    expect(selected?.get('border-top-color')).toBeDefined();
  });

  it('no forced-colours block removes a border or outline from an app control', () => {
    const offenders: string[] = [];
    for (const [file, css] of allStylesheets()) {
      for (const block of blocksOf(css, '@media (forced-colors: active) {')) {
        for (const [selector, decls] of rulesIn(block)) {
          for (const [prop, value] of decls) {
            const removes = /^(outline|border(-[a-z]+)?)$/.test(prop) && /^(none|0)\b/.test(value);
            const removesStyle = /^border-[a-z]+-style$/.test(prop) && value === 'none';
            if (removes || removesStyle) offenders.push(`${file}: ${selector} ${prop}: ${value}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the token is in the generated stylesheet at the same size tokens.ts gives', () => {
    expect(read('theme/tokens.css')).toContain(`--size-touch-target: ${TOUCH_TARGET_PX}px;`);
  });

  it('the forced-colours focus ring stays on the controls (the tokens block sets the outline)', () => {
    const tokens = read('theme/tokens.css');
    const block = blocksOf(tokens, '@media (forced-colors: active) {')[0] ?? '';
    expect(rulesIn(block).get(':focus-visible')?.get('outline')).toMatch(/CanvasText/);
  });
});
