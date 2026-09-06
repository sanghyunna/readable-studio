import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';
import { ensureRailOpen } from '@/playwright/rail';
import { T } from '@/timeouts';

const CONFIG_STORAGE_KEY = 'readable-studio:config';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
        privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
      }),
    );
  }, CONFIG_STORAGE_KEY);

  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          privacyDecisionAt: 1,
          telemetry: { metrics: false, content: false, artifactManifest: false },
        },
      },
    });
  });

  await routeAgents(page, [
    {
      id: 'mock',
      name: 'Mock Agent',
      bin: 'mock-agent',
      available: true,
      version: 'test',
      models: [{ id: 'default', label: 'Default' }],
    },
  ]);
});

async function waitForLoadingToClear(page: Page): Promise<void> {
  await page.locator('.readable-loading-shell').waitFor({ state: 'detached', timeout: T.long });
}

async function gotoEntryHome(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await expect(page.getByTestId('home-hero')).toBeVisible();
}

async function createBlankProject(page: Page): Promise<string> {
  await ensureRailOpen(page);
  await page.getByTestId('hub-new-project').click();
  await expect(page.getByTestId('new-project-modal')).toBeVisible();
  await page.getByTestId('new-project-name').fill('folder-view-state-test');
  await page.getByTestId('create-project').click();
  await waitForLoadingToClear(page);
  await expect(page).toHaveURL(/\/projects\//);

  const projectId = new URL(page.url()).pathname.split('/')[2];
  if (projectId === undefined) throw new Error('project route did not include a project id');
  return projectId;
}

test('[P1] folder view survives navigating to a file tab and back', async ({ page }) => {
  // Given: a project whose Design Files surface has a nested file.
  await gotoEntryHome(page);
  const projectId = await createBlankProject(page);
  const response = await page.request.post(`/api/projects/${projectId}/files`, {
    data: { name: 'assets/reference.txt', content: 'reference' },
    timeout: T.medium,
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await waitForLoadingToClear(page);
  await page.getByTestId('design-files-tab').click();
  await page.locator('.df-dir-row').getByRole('button', { name: /^assets\b/i }).click();

  const nestedFile = page.getByTestId('design-file-row-assets/reference.txt');
  await expect(nestedFile).toBeVisible();

  // When: the user opens the nested file in a tab and returns to Design Files.
  await nestedFile.getByRole('button', { name: /^reference\.txt\b/i }).click();
  await page.getByTestId('design-file-preview').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tab', { name: /reference\.txt/i })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('design-files-tab').click();

  // Then: the panel restores the surviving current-directory view state.
  await expect(nestedFile).toBeVisible();
});
