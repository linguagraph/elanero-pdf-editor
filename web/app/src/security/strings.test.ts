import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EN } from '../i18n/en';

// Every security.* message id the security logic names must exist in the catalogue. The action
// names (security.set, security.remove) are not message ids.
const NOT_MESSAGES = new Set(['security.set', 'security.remove']);

function idsIn(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...source.matchAll(/'(security\.[A-Za-z0-9_.-]+)'/g)].map((m) => m[1] ?? '');
}

describe('security strings', () => {
  it('every security.* id used in the logic exists in en.ts', () => {
    const ids = idsIn('./security.ts').filter((id) => !NOT_MESSAGES.has(id));
    expect(ids.length).toBeGreaterThan(0);
    const missing = ids.filter((id) => !(id in EN));
    expect(missing).toEqual([]);
  });
});
