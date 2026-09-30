import { defineConfig, devices } from '@playwright/test';

// Disposable browser-only CSS measurements; no app runtime or shared data directory.
export default defineConfig({
  testDir: '../../ui',
  testMatch: 'width-resize-platform.test.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { headless: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
