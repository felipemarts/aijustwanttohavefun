// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*', '.shots/*', '.vitest/*', 'node_modules/*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // The contract file lives outside this project; only its types may be imported, so Metro never bundles it.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Strings from the core are text, never markup.
      'react/no-danger': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Core strings are text only.' },
      ],
    },
  },
]);
