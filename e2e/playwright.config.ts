import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonPort = Number(process.env.READABLE_PORT) || 17_456;
const webPort = Number(process.env.READABLE_WEB_PORT) || 17_573;
const baseURL = `http://127.0.0.1:${webPort}`;
const namespace = process.env.READABLE_E2E_NAMESPACE || `playwright-${process.pid}`;
const dataDir = process.env.READABLE_E2E_DATA_DIR || `e2e/ui/.readable-studio-data/${namespace}`;
const uiDir = fileURLToPath(new URL('./ui', import.meta.url));
const reportDir = join(uiDir, 'reports');

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export default defineConfig({
  testDir: uiDir,
  outputDir: join(reportDir, 'test-results'),
  timeout: Number(process.env.READABLE_PLAYWRIGHT_TIMEOUT) || 90_000,
  retries: process.env.CI ? 1 : 0,
  expect: {
    timeout: 10_000,
  },
  // The webServer owns one daemon and one READABLE_DATA_DIR for the entire UI suite.
  // Keep backend-mutating UI tests serialized until the harness can boot an
  // isolated daemon/data directory per worker.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never', outputFolder: join(reportDir, 'playwright-html-report') }],
        ['json', { outputFile: join(reportDir, 'results.json') }],
        ['junit', { outputFile: join(reportDir, 'junit.xml') }],
      ]
    : [
        ['list'],
        ['html', { open: 'never', outputFolder: join(reportDir, 'playwright-html-report') }],
        ['json', { outputFile: join(reportDir, 'results.json') }],
        ['junit', { outputFile: join(reportDir, 'junit.xml') }],
      ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:READABLE_DATA_DIR=${powerShellQuote(dataDir)}; ` +
      `pnpm --dir .. tools-dev run web --namespace ${powerShellQuote(namespace)} --daemon-port ${daemonPort} --web-port ${webPort}"`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
