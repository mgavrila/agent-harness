import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-global-setup.ts'],
    // The checkpointer test shares one Postgres database with the rest of the workspace suite.
    fileParallelism: false,
  },
});
