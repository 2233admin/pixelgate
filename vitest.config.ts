import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // e2e tests share one server and mutate page state in order.
    sequence: { concurrent: false },
  },
});
