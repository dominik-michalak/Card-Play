import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-db.ts'],
    // database tests share one test database
    fileParallelism: false,
  },
});
