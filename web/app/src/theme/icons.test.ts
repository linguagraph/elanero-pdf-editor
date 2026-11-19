import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { REGISTRY, MENU } from '../commands/catalog';
import { isIconName } from '../commands/registry';
import { Icon } from './Icon';
import { ICONS } from './icons.generated';
import { parseIconSvg, renderIconsModule } from './icon-source';

const here = dirname(fileURLToPath(import.meta.url));
// src/theme -> web/app -> web -> repo root.
const iconDir = resolve(here, '../../../../src/pdfeditor/data/icons');
const committed = readFileSync(resolve(here, 'icons.generated.ts'), 'utf8');

const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">';

function svg(body: string, head = SVG_HEAD): string {
  return `${head}${body}</svg>`;
}

describe('icons.generated.ts', () => {
  it('matches the generator output (run `npm run icons` after changing an icon)', () => {
    const icons = readdirSync(iconDir)
      .filter((file) => file.endsWith('.svg'))
      .sort()
      .map((file) =>
        parseIconSvg(file.slice(0, -'.svg'.length), readFileSync(resolve(iconDir, file), 'utf8')),
      );
    expect(committed).toBe(renderIconsModule(icons));
  });

  it('holds every bundled icon', () => {
    const files = readdirSync(iconDir).filter((file) => file.endsWith('.svg'));
    expect(Object.keys(ICONS)).toHaveLength(files.length);
  });
});

describe('parseIconSvg', () => {
  it('reads the drawing elements and their attributes', () => {
    const icon = parseIconSvg(
      'dot',
      svg('<circle cx="1" cy="2" r="3" fill="currentColor" /><path d="M0 0h1" />'),
    );
    expect(icon.elements).toEqual([
      ['circle', { cx: '1', cy: '2', r: '3', fill: 'currentColor' }],
      ['path', { d: 'M0 0h1' }],
    ]);
  });

  it('rejects a script element', () => {
    expect(() => parseIconSvg('bad', svg('<script>alert(1)</script>'))).toThrow(
      /unsupported markup/,
    );
    expect(() => parseIconSvg('bad', svg('<script src="x" />'))).toThrow(/<script> is not allowed/);
  });

  it('rejects an on* event attribute on a drawing element', () => {
    expect(() => parseIconSvg('bad', svg('<path d="M0 0" onload="x()" />'))).toThrow(
      /attribute onload is not allowed/,
    );
  });

  it('rejects an on* attribute on the root element', () => {
    const head = '<svg viewBox="0 0 24 24" onload="x()">';
    expect(() => parseIconSvg('bad', svg('<path d="M0 0" />', head))).toThrow(/onload/);
  });

  it('rejects an unknown element', () => {
    expect(() => parseIconSvg('bad', svg('<foreignObject />'))).toThrow(/not allowed/);
  });

  it('rejects a fill other than currentColor', () => {
    expect(() => parseIconSvg('bad', svg('<path d="M0 0" fill="red" />'))).toThrow(
      /attribute fill is not allowed/,
    );
  });

  it('rejects text content and nested groups', () => {
    expect(() => parseIconSvg('bad', svg('text<path d="M0 0" />'))).toThrow(/unsupported markup/);
    expect(() => parseIconSvg('bad', svg('<g><path d="M0 0" /></g>'))).toThrow(
      /unsupported markup/,
    );
  });

  it('rejects a grid other than 24 units', () => {
    const head = '<svg viewBox="0 0 16 16">';
    expect(() => parseIconSvg('bad', svg('<path d="M0 0" />', head))).toThrow(/24-unit grid/);
  });

  it('rejects an icon name that is not a lowercase word', () => {
    expect(() => parseIconSvg('Bad_Name', svg('<path d="M0 0" />'))).toThrow(/icon names/);
  });
});

describe('command icons', () => {
  it('resolves every ribbon and app-menu command to a bundled icon', () => {
    const ribbon = REGISTRY.commands.filter((def) => {
      const tab = REGISTRY.groups.find((group) => group.id === def.group)?.tab;
      return tab !== null && tab !== undefined;
    });
    const ids = new Set([...ribbon.map((def) => def.id), ...MENU.flat()]);
    const missing = [...ids].filter((id) => {
      const icon = REGISTRY.icon(id);
      return icon === undefined || !isIconName(icon);
    });
    expect(missing).toEqual([]);
  });

  it('renders an aria-hidden svg with one element per drawing element', () => {
    const html = renderToStaticMarkup(createElement(Icon, { name: 'save' }));
    expect(html).toContain('aria-hidden="true"');
    expect(html.startsWith('<svg')).toBe(true);
    const drawn = (html.match(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/g) ?? []).length;
    expect(drawn).toBe(ICONS.save.length);
  });
});
