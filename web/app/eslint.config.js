import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'playwright-report/',
      'test-results/',
      'src/rpc/generated.ts',
      // Generated from the bundled SVGs by scripts/generate-icons.ts.
      'src/theme/icons.generated.ts',
      // Staged Pyodide files (scripts/stage_engine_assets.mjs): third-party, not our code.
      'public/engine-assets/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
);
