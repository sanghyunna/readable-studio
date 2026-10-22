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
    // chdir and PATH mutations require a separate process for each file.
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    include: ['tests/**/*.test.{ts,tsx,js,mjs,cjs}'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
  },
});
