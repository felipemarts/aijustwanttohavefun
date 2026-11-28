import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Imports the platform-neutral library must never make: the device comes in through ports. */
const platformImports = {
  patterns: [
    { group: ['node:*', 'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'child_process'], message: 'Node APIs belong in src/node (a port implementation).' },
    { group: ['react', 'react-native', 'react-native-*', 'expo', 'expo-*', '@expo/*', 'llama.rn'], message: 'Device libraries belong in the app, behind a port.' },
  ],
};

export default tseslint.config(
  { ignores: ['node_modules/**', '.vitest/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { globals: { ...globals.es2022 } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/node/**'],
    rules: { 'no-restricted-imports': ['error', platformImports] },
  },
  {
    files: ['src/node/**/*.ts', 'test/**/*.ts', 'harness/**/*.ts', '*.config.*'],
    languageOptions: { globals: { ...globals.node } },
  },
);
