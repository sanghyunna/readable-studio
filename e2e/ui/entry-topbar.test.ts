import { expect, test } from '@playwright/test';
import { addStorageInitScript } from '@/playwright/storage-init';
import { routeAgents } from '@/playwright/mock-factory';
import { ensureRailOpen } from '@/playwright/rail';
import { expectInlineUseEverywhereGuide } from '@/playwright/use-everywhere';
import type { Page } from '@playwright/test';

const STORAGE_KEY = 'readable-studio:config';
const SETTINGS_LABEL = /Settings|설정|设置|設定/i;

test.describe.configure({ timeout: 30_000 });

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await ensureRailOpen(page);
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

function topbarSwitcher(page: Page) {
  return page.locator('.entry-main__topbar').getByTestId('inline-model-switcher-chip');
}

function heroAgentSwitcher(page: Page) {
  return page.getByTestId('home-hero-agent-model').getByTestId('inline-model-switcher-agent-trigger');
}

async function openLibraryDestination(page: Page, destination: string) {
  await page.getByTestId('hub-library').click();
  await page.getByTestId(`hub-library-${destination}`).click();
}

test.beforeEach(async ({ page }) => {
  await addStorageInitScript(page, (key) => {
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

test('[P2] home composer keeps execution controls while the topbar omits the retired trio', async ({ page }) => {
  await gotoEntryHome(page);
  const topbar = page.locator('.entry-main__topbar');
  await expect(topbar).toBeVisible();
  await expect(topbarSwitcher(page)).toBeHidden();
  await expect(heroAgentSwitcher(page)).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-model-trigger')).toBeVisible();
  await expect(topbar.getByTestId('entry-run-status')).toHaveCount(0);
  await expect(topbar.getByTestId('entry-help-trigger')).toHaveCount(0);
  await expect(topbar.getByTestId('entry-settings-menu-trigger')).toHaveCount(0);
  await expect(page.getByTestId('hub-footer-settings')).toHaveAccessibleName(SETTINGS_LABEL);
});

test('[P1] home composer agent control reflects the selected CLI and opens its body-level switcher', async ({ page }) => {
  await gotoEntryHome(page);
  const control = heroAgentSwitcher(page);
  await expect(control).toHaveAccessibleName(/Agent: Codex CLI/i);
  await control.click();
  const popover = page.getByTestId('inline-model-switcher-agent-popover');
  await expect(popover).toBeVisible();
  await expect(page.locator('body > [data-testid="inline-model-switcher-agent-popover"]')).toBeVisible();
  await expect(page.locator('.entry-main__topbar-chips').getByTestId('inline-model-switcher-agent-popover')).toHaveCount(0);
  await expect(page.getByTestId('inline-model-switcher-agent-codex')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-agent-mock')).toBeVisible();
});

test('[P2] retired help and account controls stay absent while footer settings remains reachable', async ({ page }) => {
  await gotoEntryHome(page);
  await expect(page.getByTestId('entry-help-trigger')).toHaveCount(0);
  await expect(page.getByTestId('entry-help-menu')).toHaveCount(0);
  await expect(page.getByTestId('entry-settings-menu-trigger')).toHaveCount(0);

  await page.getByTestId('hub-footer-settings').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Execution mode' })).toBeVisible();
});

test('[P2] home Library loads the inline Integrations guide without the retired modal', async ({ page }) => {
  await expectInlineUseEverywhereGuide(page, async () => {
    await gotoEntryHome(page);
    await openLibraryDestination(page, 'integrations');
  });
});

test('[P1] footer settings opens execution settings and closes the composer execution popover', async ({ page }) => {
  await gotoEntryHome(page);
  await heroAgentSwitcher(page).click();
  const popover = page.getByTestId('inline-model-switcher-agent-popover');
  await expect(popover).toBeVisible();
  await page.getByTestId('hub-footer-settings').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Execution mode' })).toBeVisible();
  await expect(popover).toHaveCount(0);
});

test('[P2] returning from another entry view via the home nav reaches the Hub composer', async ({ page }) => {
  await gotoEntryHome(page);
  await openLibraryDestination(page, 'integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  await ensureRailOpen(page);
  await page.getByTestId('hub-brand').click();
  await expect(page.locator('[data-project-rail]')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
});
