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
  {
    // W8.6 S2 (W1.1 §10 E): PDF-derived strings render as React text only. Nothing in the app
    // may turn a string into markup or code, so these sinks are banned in shipped source.
    // Test files are exempt: jsdom tests build fixtures with innerHTML, and the pwa test uses
    // new Function to evaluate a literal taken from the built file.
    ignores: ['**/*.test.{ts,tsx}', '**/*.spec.ts'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error', // also refuses setTimeout('code string')
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
          message:
            'innerHTML/outerHTML assignment is banned (W8.6, W1.1 §10 E). Render React text.',
        },
        {
          selector: 'CallExpression > MemberExpression.callee[property.name="insertAdjacentHTML"]',
          message: 'insertAdjacentHTML is banned (W8.6, W1.1 §10 E). Render React text.',
        },
        {
          selector:
            'CallExpression > MemberExpression.callee[object.name="document"][property.name=/^write(ln)?$/]',
          message: 'document.write is banned (W8.6, W1.1 §10 E).',
        },
        {
          // no-implied-eval misses a global setTimeout that is not declared in the config.
          selector:
            'CallExpression[callee.name=/^(setTimeout|setInterval)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]',
          message: 'setTimeout/setInterval with a string is banned (W8.6, W1.1 §10 E).',
        },
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: 'dangerouslySetInnerHTML is banned (W8.6, W1.1 §10 E). Render React text.',
        },
      ],
    },
  },
);
