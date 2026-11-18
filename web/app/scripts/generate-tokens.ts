// Writes src/theme/tokens.css from src/theme/tokens.ts.
// Usage: npm run tokens (write) or npm run tokens:check (exit 1 when the committed file is stale).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/theme/tokens-css.ts';

const outPath = fileURLToPath(new URL('../src/theme/tokens.css', import.meta.url));
const expected = renderTokensCss();

if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(outPath, 'utf8');
  } catch {
    // A missing file is stale too.
  }
  if (actual !== expected) {
    console.error('src/theme/tokens.css is stale; run `npm run tokens` and commit the result.');
    process.exit(1);
  }
  console.log('src/theme/tokens.css is up to date.');
} else {
  writeFileSync(outPath, expected);
  console.log('Wrote src/theme/tokens.css');
}
