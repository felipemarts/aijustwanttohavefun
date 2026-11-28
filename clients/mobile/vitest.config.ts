import { defineConfig } from 'vitest/config';

// Unit tests cover the parts without React Native: the cores, the store, the i18n files and the sprite maths.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
