import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'src/generated', 'supabase', 'playwright-report', 'test-results', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // RPC only (CLAUDE.md rule 1): never read tables directly.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='from'][callee.object.name=/supabase/]",
          message: 'Never call supabase.from(): the API exposes RPCs only.',
        },
      ],
    },
  },
  {
    // Components never talk to supabase directly (CLAUDE.md repo layout).
    files: ['src/components/**/*.{ts,tsx}', 'src/features/**/*.tsx', 'src/app/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@/lib/supabase', message: 'Use a hook in src/features/* that calls src/lib/rpc.' }] },
      ],
    },
  },
);
