import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The eval database is shared state; run files one at a time.
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
