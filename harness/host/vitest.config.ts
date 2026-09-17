import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-global-setup.ts'],
    // The suite shares one Postgres database and truncates between tests.
    fileParallelism: false,
  },
});
