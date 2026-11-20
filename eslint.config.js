// Lint with every rule on from the first commit and no suppressions file (ADR 0031).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.agents/**', '.claude/**'] },
  {
    files: ['**/*.{ts,mjs,js,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error', noInlineConfig: true },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Logs go through the request's logger, which redacts (ADR 0026).
      'no-console': 'error',
      // Files stay small (ADR 0027).
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name=/^(slice|substring|substr)$/][callee.object.callee.property.name='toISOString']",
          message: "That is UTC's date, not the patient's or the tenant's. Use localDate(instant, timeZone) from src/lib/time.ts (ADR 0017).",
        },
        {
          selector: "MemberExpression[property.name='ip'][object.name=/^(request|req)$/]",
          message: 'request.ip believes any X-Forwarded-For a caller writes. Use request.clientIp (ADR 0030).',
        },
        {
          selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='NODE_ENV']",
          message: 'Read the environment from src/config/env.ts (MEDORA_ENV). Never branch a gate on NODE_ENV.',
        },
      ],
    },
  },
);
