import { expect, test } from '@playwright/test';
import { ensureRailOpen } from '@/playwright/rail';
import type { Page } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { openNewProjectModal } from '@/playwright/new-project-modal';
import { T } from '@/timeouts';

test.describe.configure({ timeout: 30_000 });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

test('[P0] @critical home loads with the primary entry controls', async ({ page }) => {
  await gotoEntryHome(page);

  // The Hub rail is the primary Home navigation surface. Its toggle and New
  // Project action must both be discoverable and interactable after expansion.
  const hubRail = page.locator('[data-project-rail]');
  const railToggle = page.locator('[data-project-rail-toggle]');
  await expect(hubRail).toBeVisible();
  await expect(railToggle).toBeVisible();
  await expect(railToggle).toBeEnabled();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  await ensureRailOpen(page);
  await expect(railToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('hub-new-project')).toBeVisible();
  await expect(page.getByTestId('hub-new-project')).toBeEnabled();
});

test('[P0] @critical settings dialog is reachable from home', async ({ page }) => {
  await gotoEntryHome(page);

  // The Hub footer gear is Home's supported settings entry point and opens
  // the full execution-mode dialog directly.
  const settings = page.getByTestId('hub-footer-settings');
  await expect(settings).toBeVisible();
  await expect(settings).toBeEnabled();
  await settings.click();
  const settingsDialog = page.getByRole('dialog');
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole('heading', { name: 'Execution mode' })).toBeVisible();
});

test('[P0] @critical prototype project creation reaches the workspace shell', async ({ page }) => {
  await gotoEntryHome(page);
  await prepareAndOpenNewProjectModal(page);
  await page.getByTestId('new-project-tab-prototype').click();
  await page.getByTestId('new-project-name').fill('Critical smoke project');
  await page.getByTestId('create-project').click();

  await expectWorkspaceReady(page);
});

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
    await expect(privacyDialog).toHaveCount(0);
  }
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function prepareAndOpenNewProjectModal(page: Page) {
  await openNewProjectModal(page);
  await expect(page.getByTestId('new-project-panel')).toBeVisible();
}

async function expectWorkspaceReady(page: Page) {
  await waitForLoadingToClear(page);
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
}

async function waitForLoadingToClear(page: Page) {
  await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: T.medium });
}
