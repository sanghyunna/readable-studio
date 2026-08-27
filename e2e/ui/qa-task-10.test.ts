import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const EVIDENCE_DIR = 'D:/readable-studio/.omo/evidence/task-10';

async function seedProject(request: APIRequestContext, name: string, sessions: string[]) {
  const id = `task-10-${name.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;
  const response = await request.post('/api/projects', {
    data: {
      id,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = (await response.json()).project as { id: string };
  const created = [] as { id: string; title: string }[];
  for (const title of sessions) {
    const conversationResponse = await request.post(`/api/projects/${project.id}/conversations`, {
      data: { title },
    });
    expect(conversationResponse.ok()).toBeTruthy();
    created.push((await conversationResponse.json()).conversation);
  }
  return { id: project.id, sessions: created };
}

async function gotoHub(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.removeItem('readable-studio:workspace-tabs:v1');
    window.localStorage.setItem('readable-studio:config', JSON.stringify({
      mode: 'daemon',
      agentId: 'codex',
      agentModels: {},
      agentCliEnv: {},
      onboardingCompleted: true,
      privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    }));
  });
  await page.goto('/');
  await expect(page.getByTestId('entry-view-home')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('hub-nav')).toBeVisible();
}

test('todo 10 command palette, global shortcuts, and tree shortcuts', async ({ page, request, context }) => {
  const alpha = await seedProject(request, 'Alpha Quarterly', ['Chart cleanup', 'Legend correction']);
  const zeta = await seedProject(request, 'Zeta Pricing', ['Pricing comparison']);
  await gotoHub(page);
  await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();

  // Palette opens from the approved shortcut and resets state on every open.
  const prior = page.getByTestId('hub-search');
  await prior.focus();
  await page.keyboard.press('Control+K');
  await expect(page.getByTestId('hub-command-palette')).toBeVisible();
  await expect(page.getByTestId('hub-palette-input')).toBeFocused();
  await expect(page.getByTestId('hub-palette-item-project-' + alpha.id)).toBeVisible();
  await expect(page.getByTestId('hub-palette-item-session-' + alpha.sessions[0]!.id)).toBeVisible();
  await expect(page.getByTestId('hub-palette-item-destination-plugins')).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE_DIR}/palette.png`, fullPage: true });

  const selected = page.locator('.hub-palette__item[aria-selected="true"]');
  await page.keyboard.press('ArrowDown');
  await expect(selected).toHaveAttribute('data-kind', 'project');
  await expect(selected).toContainText('Alpha Quarterly');
  await page.keyboard.press('ArrowUp');
  await expect(selected).toContainText('Zeta Pricing');

  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('[data-testid="hub-command-palette"]')?.contains(document.activeElement),
  )).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('hub-palette-input')).toBeFocused();

  await page.getByTestId('hub-palette-input').fill('old stale query');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hub-command-palette')).toHaveCount(0);
  await expect(prior).toBeFocused();
  await page.keyboard.press('Control+K');
  await expect(page.getByTestId('hub-palette-input')).toHaveValue('');
  await expect(page.locator('.hub-palette__item[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('.hub-palette__item').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(prior).toBeFocused();

  // Repeated interruption: abandon a filtered navigation and still restore focus.
  await page.keyboard.press('Control+K');
  await page.getByTestId('hub-palette-input').fill('Plugins');
  await page.keyboard.press('Escape');
  await expect(prior).toBeFocused();

  // Project and session result kinds activate their real routes too.
  await page.keyboard.press('Control+K');
  await page.getByTestId('hub-palette-input').fill('Alpha Quarterly');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${alpha.id}$`));
  await expect(page.getByTestId('project-title')).toContainText('Alpha Quarterly');
  await page.close();
  page = await context.newPage();
  await gotoHub(page);
  await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();
  await page.keyboard.press('Control+K');
  await page.getByTestId('hub-palette-input').fill('Chart cleanup');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${alpha.id}/conversations/${alpha.sessions[0]!.id}`));
  await expect(page.getByTestId('project-title')).toContainText('Alpha Quarterly');
  await page.close();
  page = await context.newPage();
  await gotoHub(page);
  await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();

  // Global shortcuts: new project, new session, rail collapse, inspector seam.
  await page.keyboard.press('Control+N');
  await expect(page.getByTestId('new-project-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('new-project-modal')).toHaveCount(0);

  const projectRow = page.getByTestId(`hub-project-${alpha.id}`);
  await projectRow.focus();
  const createSessionRequest = page.waitForRequest((request) =>
    request.method() === 'POST' && request.url().endsWith(`/api/projects/${alpha.id}/conversations`),
    { timeout: 10_000 },
  );
  await projectRow.press('Control+Shift+N');
  await createSessionRequest;
  await expect(page).toHaveURL(new RegExp(`/projects/${alpha.id}/conversations/`));
  await page.close();
  page = await context.newPage();
  await gotoHub(page);
  await expect(page.getByTestId(`hub-session-${alpha.sessions[0]!.id}`)).toBeVisible();

  await page.getByTestId('hub-brand').focus();
  await page.keyboard.press('Control+B');
  await expect(page.locator('.hub')).toHaveAttribute('data-rail-collapsed', 'true');
  await page.keyboard.press('Control+B');
  await expect(page.locator('.hub')).toHaveAttribute('data-rail-collapsed', 'false');

  await page.evaluate(() => {
    (window as Window & { __inspectorShortcutCount?: number }).__inspectorShortcutCount = 0;
    window.addEventListener('readable:hub-inspector-toggle', () => {
      const target = window as Window & { __inspectorShortcutCount?: number };
      target.__inspectorShortcutCount = (target.__inspectorShortcutCount ?? 0) + 1;
    }, { once: true });
  });
  await page.keyboard.press('Control+I');
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __inspectorShortcutCount?: number }).__inspectorShortcutCount,
  )).toBe(1);

  // Tree F2, Delete, and type-ahead use real daemon mutations.
  const renameRow = page.getByTestId(`hub-session-${alpha.sessions[1]!.id}`);
  await renameRow.focus();
  const renameRequest = page.waitForResponse((response) =>
    response.request().method() === 'PATCH' && response.url().endsWith(`/conversations/${alpha.sessions[1]!.id}`),
  );
  await page.keyboard.press('F2');
  const renameInput = page.getByTestId(`hub-rename-${alpha.sessions[1]!.id}`);
  await renameInput.fill('Renamed legend');
  await renameInput.press('Enter');
  expect((await renameRequest).ok()).toBeTruthy();
  await expect(renameRow).toContainText('Renamed legend');

  const deleteRow = page.getByTestId(`hub-session-${zeta.sessions[0]!.id}`);
  await deleteRow.focus();
  const deleteResponse = page.waitForResponse((response) =>
    response.request().method() === 'DELETE' && response.url().endsWith(`/conversations/${zeta.sessions[0]!.id}`),
  );
  await page.keyboard.press('Delete');
  expect((await deleteResponse).ok()).toBeTruthy();
  await expect(deleteRow).toHaveCount(0);

  await page.getByTestId(`hub-project-${alpha.id}`).focus();
  await page.keyboard.type('Z');
  await expect(page.getByTestId(`hub-project-${zeta.id}`)).toBeFocused();

  await expect(page.getByTestId('hub-open-palette')).toContainText('Ctrl K');

  // Enter performs real destination navigation; prove both route and mounted target.
  await page.keyboard.press('Control+K');
  await page.getByTestId('hub-palette-input').fill('Plugins');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByTestId('entry-view-plugins')).toHaveAttribute('data-active', 'true');
});
