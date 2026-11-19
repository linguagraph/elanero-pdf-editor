// Writes src/theme/icons.generated.ts from the bundled icons in src/pdfeditor/data/icons.
// Usage: npm run icons (write) or npm run icons:check (exit 1 when the committed file is stale).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type IconData, parseIconSvg, renderIconsModule } from '../src/theme/icon-source.ts';

const iconDir = fileURLToPath(new URL('../../../src/pdfeditor/data/icons/', import.meta.url));
const outPath = fileURLToPath(new URL('../src/theme/icons.generated.ts', import.meta.url));

const icons: IconData[] = readdirSync(iconDir)
  .filter((file) => file.endsWith('.svg'))
  .sort()
  .map((file) => parseIconSvg(file.slice(0, -'.svg'.length), readFileSync(iconDir + file, 'utf8')));
const expected = renderIconsModule(icons);

if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(outPath, 'utf8');
  } catch {
    // A missing file is stale too.
  }
  if (actual !== expected) {
    console.error(
      'src/theme/icons.generated.ts is stale; run `npm run icons` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`src/theme/icons.generated.ts is up to date (${icons.length} icons).`);
} else {
  writeFileSync(outPath, expected);
  console.log(`Wrote src/theme/icons.generated.ts (${icons.length} icons)`);
}
