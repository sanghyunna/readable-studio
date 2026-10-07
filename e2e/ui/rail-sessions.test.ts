import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  createEmptySessionFromHub,
  dragSessionTo,
  moveSessionViaMenu,
  pressNewSession,
} from '@/playwright/new-project-modal';
import { addStorageInitScript } from '@/playwright/storage-init';
import { routeAgents } from '@/playwright/mock-factory';

async function createFolder(request: APIRequestContext, name: string): Promise<{ id: string; name: string }> {
  const response = await request.post('/api/folders', { data: { name } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json() as { folder: { id: string; name: string } }).folder;
}

async function createSession(
  request: APIRequestContext,
  title: string,
  folderId: string | null = null,
): Promise<{ id: string; workspaceId: string }> {
  const response = await request.post('/api/sessions', {
    data: { title, name: title, folderId, metadata: { kind: 'prototype' } },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { session: { id: string; projectId: string } };
  return { id: body.session.id, workspaceId: body.session.projectId };
}

async function gotoHub(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function expandFolder(page: Page, folderId: string): Promise<void> {
  const row = page.getByTestId(`hub-project-${folderId}`);
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

test.describe('rail sessions', () => {
  test.beforeEach(async ({ page }) => {
    const config = {
      mode: 'daemon', agentId: 'mock', skillId: null, designSystemId: null,
      agentModels: { mock: { model: 'default' } }, onboardingCompleted: true,
      privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false },
    };
    await addStorageInitScript(page, (value) => {
      localStorage.setItem('readable-studio:config', JSON.stringify(value));
      localStorage.setItem('readable-studio:welcome-modal-shown', '1');
    }, config);
    await routeAgents(page, [{
      id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test',
      models: [{ id: 'default', label: 'Default' }],
    }]);
    await page.route('**/api/app-config', (route) => route.request().method() === 'GET'
      ? route.fulfill({ json: { config } })
      : route.continue());
  });

  test('[P1] journeys 1-6: create, folder context, move, drag, and keyboard move', async ({ page, request }) => {
    const run = randomUUID().slice(0, 8);
    const folder = await createFolder(request, `Rail folder ${run}`);
    const secondFolder = await createFolder(request, `Rail target ${run}`);
    const recent = await createSession(request, `Recent ${run}`);
    const folderSession = await createSession(request, `Folder session ${run}`, folder.id);

    // 1. New session opens the focused Hub composer without a selected folder.
    await gotoHub(page);
    await pressNewSession(page, 'journey-1');
    await expect(page.getByTestId('home-hero-folder-chip')).toHaveCount(0);
    const createdId = await createEmptySessionFromHub(page, { context: 'journey-1-create' });
    await expect(page.getByTestId(`hub-session-${createdId}`)).toHaveAttribute('data-folder', 'none');

    // 2. Selecting a folder on Hub supplies the composer pill and keeps its new session there.
    await gotoHub(page);
    await page.getByTestId(`hub-project-${folder.id}`).click();
    await expect(page.getByTestId('home-hero-folder-chip')).toContainText(folder.name);
    const folderComposer = page.getByTestId('home-hero-input');
    await folderComposer.click();
    await folderComposer.pressSequentially(`Folder-created ${run}`);
    await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
    const posted = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions',
    );
    await page.getByTestId('home-hero-submit').click();
    const createdResponse = await posted;
    expect(createdResponse.ok()).toBe(true);
    const created = await createdResponse.json() as { session: { id: string; projectId: string } };
    await expect(page).toHaveURL(new RegExp(`/projects/${created.session.projectId}/conversations/${created.session.id}$`));
    await page.goBack();
    await expect(page.getByTestId(`hub-session-${created.session.id}`)).toHaveAttribute('data-folder', folder.id);

    // 3. Folder + selects its context instead of creating immediately; New session clears it.
    const folderNewSession = page.getByTestId(`hub-new-session-${secondFolder.id}`);
    await page.getByTestId(`hub-project-${secondFolder.id}`).hover();
    await folderNewSession.click();
    await expect(page.getByTestId('home-hero-folder-chip')).toContainText(secondFolder.name);
    await page.getByTestId('hub-new-session').click();
    await expect(page.getByTestId('home-hero-folder-chip')).toHaveCount(0);

    // 4. Menu move performs the round trip between a folder and recents.
    await moveSessionViaMenu(page, recent.id, folder.id);
    await expandFolder(page, folder.id);
    await moveSessionViaMenu(page, recent.id, null);

    // 5. Native drag-and-drop uses those same destinations.
    await dragSessionTo(page, recent.id, secondFolder.id);
    await expandFolder(page, secondFolder.id);
    await dragSessionTo(page, recent.id, null);

    // 6. Keyboard context menu reaches the move drill-down and returns the row to recents.
    await expandFolder(page, folder.id);
    const keyboardRow = page.getByTestId(`hub-session-${folderSession.id}`);
    await keyboardRow.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId('hub-row-menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('hub-row-menu-move')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`hub-row-menu-move-none`)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(keyboardRow).toHaveAttribute('data-folder', 'none');
  });
});
