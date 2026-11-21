import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['dotenv/config'],
    globalSetup: 'test/integration/globalSetup.ts',
    testTimeout: 600000,
    fileParallelism: false,
  },
});
