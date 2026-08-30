import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./lib', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['specs/**/*.spec.ts', 'tests/**/*.test.ts'],
    // Every e2e file boots its own daemon + Next runtime. Running files in
    // parallel exhausts Windows memory (VirtualAlloc failures, esbuild/tsx
    // worker crashes) and the resulting timeouts look like product defects.
    fileParallelism: false,
  },
});
