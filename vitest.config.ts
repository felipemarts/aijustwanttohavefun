import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,tools}/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The engine fuzzers take about 35 s each on a quiet machine and over 60 s on a loaded one.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
