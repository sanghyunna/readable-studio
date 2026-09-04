import { expect, test } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';
import type { Page } from '@playwright/test';

const STORAGE_KEY = 'readable-studio:config';
const LOCAL_CLI_LABEL = /Local CLI|本机 CLI|本地 CLI/i;
const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定/i;

test.describe.configure({ timeout: 30_000 });

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await expect(page.getByTestId('hub-nav')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

function heroSwitcher(page: Page) {
  return page.getByTestId('home-hero-agent-model').getByTestId('inline-model-switcher-chip');
}

async function openLibraryDestination(page: Page, destination: string) {
  await page.getByTestId('hub-library').click();
  await page.getByTestId(`hub-library-${destination}`).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem(key, JSON.stringify({
      mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
      agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true,
      agentModels: { codex: { model: 'default', reasoning: 'default' } }, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    }));
  }, STORAGE_KEY);
  await routeAgents(page, [
    { id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '0.80.0', path: '/usr/local/bin/codex', models: [{ id: 'default', label: 'Default' }] },
    { id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] },
  ]);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { config: {
      onboardingCompleted: true, agentId: 'codex', skillId: null, designSystemId: null, mode: 'daemon',
      agentModels: { codex: { model: 'default', reasoning: 'default' } }, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    } } });
  });
});

test('[P2] home topbar exposes execution status, help, account settings, and the execution switcher', async ({ page }) => {
  await gotoEntryHome(page);
  await expect(page.locator('.entry-main__topbar')).toBeVisible();
  const status = page.getByTestId('entry-run-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute('data-live', /^(true|false)$/);
  await expect(status).toHaveAccessibleName(/Settings.*(?:running|offline)/i);
  await expect(page.locator('.entry-main__topbar').getByTestId('entry-help-trigger')).toBeVisible();
  await expect(heroSwitcher(page)).toBeVisible();
  await expect(page.getByRole('button', { name: OPEN_SETTINGS_LABEL })).toBeVisible();
});

test('[P1] home composer execution control reflects the selected Local CLI agent and opens its body-level switcher', async ({ page }) => {
  await gotoEntryHome(page);
  const control = heroSwitcher(page);
  await expect(control).toHaveAccessibleName(new RegExp(`(?:${LOCAL_CLI_LABEL.source}).*Codex CLI.*default`, 'i'));
  await control.click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  await expect(page.locator('body > [data-testid="inline-model-switcher-popover"]')).toBeVisible();
  await expect(page.locator('.entry-main__topbar-chips').getByTestId('inline-model-switcher-popover')).toHaveCount(0);
  await expect(page.getByTestId('inline-model-switcher-mode-daemon')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('inline-model-switcher-agent-codex')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-agent-mock')).toBeVisible();
});

test('[P2] home help menu exposes the current support and feature-request actions', async ({ page }) => {
  await gotoEntryHome(page);
  await page.locator('.entry-main__topbar').getByTestId('entry-help-trigger').click();
  const menu = page.getByTestId('entry-help-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('entry-help-help')).toHaveRole('menuitem');
  await expect(page.getByTestId('entry-help-feature')).toHaveRole('menuitem');
});

test('[P2] home Library navigates to Integrations with the tab selected', async ({ page }) => {
  await gotoEntryHome(page);
  await openLibraryDestination(page, 'integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  await expect(page.getByTestId('integrations-tab-use-everywhere')).toBeVisible();
});

test('[P1] home status icon opens execution settings and closes the composer execution popover', async ({ page }) => {
  await gotoEntryHome(page);
  await heroSwitcher(page).click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  await page.getByTestId('entry-run-status').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Execution mode' })).toBeVisible();
  await expect(popover).toHaveCount(0);
});

test('[P2] returning from another entry view via the home nav reaches the Hub composer', async ({ page }) => {
  await gotoEntryHome(page);
  await openLibraryDestination(page, 'integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  const railToggle = page.getByTestId('entry-rail-toggle');
  if (await railToggle.isVisible()) await railToggle.click();
  await page.getByTestId('entry-nav-home').click();
  await expect(page.getByTestId('hub-nav')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
});
