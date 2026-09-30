import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@readable-studio\/contracts$/, replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: '@readable-studio/html-edit', replacement: fileURLToPath(new URL('../../packages/html-edit/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    // These suites mutate process-wide env/PATH and bind real local servers.
    // Keep files serial so fake agent binaries stay scoped to their tests.
    fileParallelism: false,
    include: ['tests/**/*.test.{ts,tsx,js,mjs,cjs}'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
  },
});
