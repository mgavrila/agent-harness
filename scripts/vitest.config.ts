import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No database, no global setup: this package only touches the filesystem.
  test: {},
});
