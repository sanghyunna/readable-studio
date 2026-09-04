import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { applyStandardMocks, fulfillAgentsRoute, STORAGE_KEY } from '@/playwright/mock-factory';

const LOCAL_CLI_LABEL = /Local CLI|本机 CLI|本地 CLI/i;
const DESIGN_SYSTEMS = [
  { id: 'agentic', title: 'Agentic', category: 'Productivity & SaaS', summary: 'Conversational AI-first interface.', surface: 'web', swatches: ['#ff5a1f', '#111827'] },
  { id: 'airbnb', title: 'Airbnb', category: 'E-Commerce & Retail', summary: 'Travel marketplace.', surface: 'web', swatches: ['#a3165b', '#ff385c'] },
] as const;

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

function heroSwitcher(page: Page) {
  return page.getByTestId('home-hero-agent-model').getByTestId('inline-model-switcher-chip');
}

function topbarSwitcher(page: Page) {
  return page.locator('.entry-main__topbar-chips').getByTestId('inline-model-switcher-chip');
}

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

async function openLibraryDestination(page: Page, destination: string) {
  await page.getByTestId('hub-library').click();
  await page.getByTestId(`hub-library-${destination}`).click();
}

async function returnHome(page: Page) {
  const toggle = page.getByTestId('entry-rail-toggle');
  if (await toggle.isVisible()) await toggle.click();
  await page.getByTestId('entry-nav-home').click();
  await expect(page.getByTestId('hub-nav')).toBeVisible();
}

test('[P0] @critical entry chrome exposes the Hub composer, navigation, and settings entry', async ({ page }) => {
  await gotoEntryHome(page);
  await expect(page.getByTestId('hub-rail-toggle')).toBeVisible();
  await expect(page.getByTestId('hub-new-project')).toBeVisible();
  await expect(page.getByTestId('hub-search')).toBeVisible();
  await expect(page.getByTestId('hub-open-palette')).toBeVisible();
  await expect(page.getByTestId('home-hero-plus-trigger')).toBeVisible();
  await expect(page.getByTestId('session-mode-trigger')).toBeVisible();
  await expect(page.getByTestId('home-hero-agent-model')).toBeVisible();
  await expect(page.getByTestId('home-hero-submit')).toBeDisabled();
  await expect(page.getByTestId('entry-run-status')).toHaveAttribute('data-live', /^(true|false)$/);
  await page.getByTestId('entry-settings-menu-trigger').click();
  await page.getByTestId('entry-settings-open-details').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Execution mode' })).toBeVisible();
});

test('[P1] Hub navigation exposes Library destinations and the moved workspace-folder action', async ({ page }) => {
  await gotoEntryHome(page);
  await page.getByTestId('hub-library').click();
  for (const destination of ['projects', 'tasks', 'plugins', 'design-systems', 'integrations']) {
    await expect(page.getByTestId(`hub-library-${destination}`)).toBeVisible();
  }
  await expect(page.getByTestId('hub-workspace-folder')).toBeVisible();
  await expect(page.getByTestId('hub-workspace-row')).not.toHaveAttribute('role', 'button');
});

test('[P1] template creation remains reachable through the Hub command palette', async ({ page }) => {
  await gotoEntryHome(page);
  await expect(page.getByText('TEMPLATE', { exact: true })).toHaveCount(0);
  await page.getByTestId('hub-open-palette').click();
  await page.getByTestId('hub-palette-input').fill('From template');
  const command = page.getByTestId('hub-palette-item-command-create-template');
  await expect(command).toBeVisible();
  await command.click();
  await expect(page.getByTestId('new-project-modal')).toBeVisible();
});

test('[P0] @critical Hub palette opens projects and Library reaches the projects index', async ({ page, request }) => {
  const id = 'entry-chrome-current-project';
  await request.delete(`/api/projects/${id}`).catch(() => undefined);
  const response = await request.post('/api/projects', { data: { id, name: 'Entry chrome project', skillId: null, designSystemId: null, metadata: { kind: 'prototype' } } });
  expect(response.ok(), await response.text()).toBeTruthy();
  await gotoEntryHome(page);
  await page.getByTestId('hub-open-palette').click();
  await page.getByTestId('hub-palette-input').fill('Entry chrome project');
  await page.getByTestId(`hub-palette-item-project-${id}`).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${id}`));
  await page.goto('/');
  await expect(page.getByTestId('hub-library')).toBeVisible();
  await openLibraryDestination(page, 'projects');
  await expect(page).toHaveURL(/\/projects$/);
});

test('[P1] design systems page is reachable from Hub Library and supports search, preview, and selection', async ({ page }) => {
  const persisted: Array<{ designSystemId?: string | null }> = [];
  await routeDesignSystems(page);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'PUT') {
      persisted.push(route.request().postDataJSON() as { designSystemId?: string | null });
      return route.fulfill({ json: { ok: true } });
    }
    if (route.request().method() === 'GET') return route.fulfill({ json: { config: { onboardingCompleted: true, agentId: 'mock', skillId: null, designSystemId: 'agentic', agentModels: {}, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } } } });
    await route.continue();
  });
  await gotoEntryHome(page);
  await openLibraryDestination(page, 'design-systems');
  await expect(page).toHaveURL(/\/design-systems$/);
  await page.getByRole('tab', { name: 'Official presets' }).click();
  await expect(page.getByTestId('design-system-card-agentic')).toContainText(/default/i);
  await page.getByTestId('design-systems-search').fill('air');
  await expect(page.getByTestId('design-system-card-airbnb')).toBeVisible();
  await page.getByTestId('design-system-preview-airbnb').click();
  await expect(page.getByRole('dialog', { name: /Airbnb preview/i })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('design-system-select-airbnb').click();
  await expect.poll(() => persisted.at(-1)?.designSystemId).toBe('airbnb');
});

test('[P2] entry chrome avoids horizontal overflow on compact desktop width', async ({ page }) => {
  for (const width of [820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await gotoEntryHome(page);
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector('.entry-main') instanceof HTMLElement ? document.querySelector<HTMLElement>('.entry-main')!.scrollWidth - document.querySelector<HTMLElement>('.entry-main')!.clientWidth : null }));
    expect(overflow.main).not.toBeNull();
    expect(overflow.main!).toBeLessThanOrEqual(2);
    expect(overflow.page).toBeLessThanOrEqual(2);
  }
});

test('[P0] @critical entry execution control opens the Local CLI and BYOK switcher', async ({ page }) => {
  await page.addInitScript((key) => window.localStorage.setItem(key, JSON.stringify({ mode: 'daemon', agentId: 'codex', onboardingCompleted: true, agentModels: { codex: { model: 'default' } }, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } })), STORAGE_KEY);
  await page.route('**/api/agents**', (route) => fulfillAgentsRoute(route, [
    { id: 'claude', name: 'Claude Code', bin: 'claude', available: true, version: '1.0.0', models: [{ id: 'default', label: 'Default' }] },
    { id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '0.80.0', models: [{ id: 'default', label: 'Default' }] },
  ]));
  await page.route('**/api/app-config', async (route) => route.request().method() === 'GET' ? route.fulfill({ json: { config: { mode: 'daemon', onboardingCompleted: true, agentId: 'codex', agentModels: { codex: { model: 'default' } }, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } } } }) : route.continue());
  await gotoEntryHome(page);
  const control = heroSwitcher(page);
  await expect(control).toHaveAccessibleName(new RegExp(`(?:${LOCAL_CLI_LABEL.source}).*Codex CLI.*default`, 'i'));
  await control.click();
  const popover = page.locator('body > [data-testid="inline-model-switcher-popover"]');
  await expect(popover).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-mode-daemon')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('inline-model-switcher-mode-api')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-agent-claude')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-agent-codex')).toBeVisible();
  await page.getByTestId('inline-model-switcher-open-settings').click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Execution mode' })).toBeVisible();
});

test('[P2] entry overlays close on outside click, Escape, and execution-settings open', async ({ page }) => {
  await gotoEntryHome(page);
  const control = heroSwitcher(page);
  const popover = page.getByTestId('inline-model-switcher-popover');
  await control.click();
  await expect(popover).toBeVisible();
  await page.getByTestId('entry-run-status').click();
  await expect(popover).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await control.click();
  await page.getByTestId('home-hero').click();
  await expect(popover).toHaveCount(0);
  await control.click();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
});

test('[P1] topbar execution control remains available across Library destinations', async ({ page }) => {
  await routeDesignSystems(page);
  await gotoEntryHome(page);
  for (const destination of ['projects', 'tasks', 'plugins', 'design-systems', 'integrations']) {
    if (!(await page.getByTestId('hub-library').isVisible())) await returnHome(page);
    await openLibraryDestination(page, destination);
    const control = topbarSwitcher(page);
    await expect(control).toBeVisible();
    await control.click();
    await expect(page.locator('body > [data-testid="inline-model-switcher-popover"]')).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('[P1] plugin registry creation remains reachable through Hub Library', async ({ page }) => {
  await gotoEntryHome(page);
  await openLibraryDestination(page, 'plugins');
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(page.getByTestId('plugins-tab-installed')).toBeVisible();
  await expect(page.getByTestId('plugins-tab-available')).toBeVisible();
  await expect(page.getByTestId('plugins-tab-sources')).toBeVisible();
  await page.getByTestId('plugins-create-button').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('hub-composer')).toBeVisible();
});

test('[P0] @critical Hub composer keeps Shift+Enter as a newline and submits on Enter', async ({ page }) => {
  await gotoEntryHome(page);
  const input = page.getByTestId('home-hero-input');
  await input.fill('Line one');
  await input.press('Shift+Enter');
  await input.type('Line two');
  const projectRequest = page.waitForRequest(isCreateProjectRequest);
  await input.press('Enter');
  expect((await projectRequest).postDataJSON()).toMatchObject({ pendingPrompt: 'Line one\nLine two' });
});

test('[P0] @critical Hub composer stages and removes attachments', async ({ page }) => {
  await gotoEntryHome(page);
  const fileInput = page.getByTestId('home-hero-file-input');
  await fileInput.setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Entry chrome attachment.\n', 'utf8') });
  const staged = page.getByTestId('home-hero-staged-files');
  await expect(staged.getByText('brief.txt', { exact: true })).toBeVisible();
  await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
  await page.getByRole('button', { name: /Remove brief\.txt/i }).click();
  await expect(staged).toHaveCount(0);
});

test('[P1] Hub rail collapse control preserves the compact navigation surface', async ({ page }) => {
  await gotoEntryHome(page);
  const hub = page.locator('.hub');
  const toggle = page.getByTestId('hub-rail-toggle');
  await toggle.click();
  await expect(hub).toHaveAttribute('data-rail-collapsed', 'true');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('hub-brand')).toBeVisible();
  await expect(page.getByTestId('hub-new-project')).toBeVisible();
  await toggle.click();
  await expect(hub).toHaveAttribute('data-rail-collapsed', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

async function routeDesignSystems(page: Page) {
  await page.route('**/api/design-systems', async (route) => route.request().method() === 'GET' ? route.fulfill({ json: { designSystems: DESIGN_SYSTEMS } }) : route.continue());
  await page.route('**/api/design-systems/*/showcase', async (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>showcase</body></html>' }));
  await page.route('**/api/design-systems/*/preview', async (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>tokens</body></html>' }));
  await page.route('**/api/design-systems/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? 'agentic');
    const system = DESIGN_SYSTEMS.find((item) => item.id === id) ?? DESIGN_SYSTEMS[0];
    await route.fulfill({ json: { designSystem: { ...system, body: `# ${system.title}` } } });
  });
}

function isCreateProjectRequest(request: Request) {
  return new URL(request.url()).pathname === '/api/projects' && request.method() === 'POST';
}
