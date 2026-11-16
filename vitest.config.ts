import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fixture projects under test/fixtures have their own tests; don't collect them here.
    include: ['test/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // e2e files mutate fixtures and start browsers; keep them sequential.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
