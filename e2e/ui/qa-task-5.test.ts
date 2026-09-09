import { expect, test } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';

import { addStorageInitScript } from '@/playwright/storage-init';

const STORAGE_KEY = 'readable-studio:config';
const CONFIG = {
  mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5',
  agentId: 'codex', skillId: null, designSystemId: null, onboardingCompleted: true,
  agentModels: { codex: { model: 'default', reasoning: 'default' } }, privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};
const PLUGIN = {
  id: 'qa-context-plugin', title: 'QA Context Plugin', version: '1.0.0', trust: 'bundled',
  sourceKind: 'bundled', source: '/tmp/qa-plugin', fsPath: '/tmp/qa-plugin',
  capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
  manifest: { name: 'qa-context-plugin', title: 'QA Context Plugin', version: '1.0.0',
    description: 'QA plugin picker entry', readable: { kind: 'scenario', taskKind: 'new-generation',
      useCase: { query: 'Use QA context.' }, inputs: [] } },
};
const SKILL = {
  id: 'qa-skill', name: 'QA Skill', description: 'QA skill picker entry', triggers: ['qa'],
  mode: 'prototype', previewType: 'html', designSystemRequired: false, defaultFor: [],
  upstream: null, hasBody: true, examplePrompt: 'Use QA Skill', aggregatesExamples: false,
};

async function gotoHome(page: import('@playwright/test').Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 20_000 });
  const privacy = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
}

async function dropFile(page: import('@playwright/test').Page, name: string, type: string, content: string) {
  await page.getByTestId('home-hero-input').evaluate((target, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([data.content], data.name, { type: data.type }));
    target.closest('.home-hero__input-card')?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.closest('.home-hero__input-card')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { name, type, content });
}

test.beforeEach(async ({ page }) => {
  await addStorageInitScript(page, ({ key, value }) => {
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem(key, JSON.stringify(value));
    const created: string[] = []; const revoked: string[] = [];
    const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
    Object.assign(window, { __qaObjectUrls: { created, revoked } });
  }, { key: STORAGE_KEY, value: CONFIG });
  await routeAgents(page, [{ id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '1', path: 'codex', models: [{ id: 'default', label: 'Default' }] }]);
  await page.route('**/api/app-config', async (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { config: CONFIG } }) : route.continue());
  await page.route('**/api/projects', async (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { projects: [] } }) : route.continue());
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: [PLUGIN] } }));
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [SKILL] } }));
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: { servers: [{ id: 'qa-mcp', label: 'QA MCP', enabled: true, transport: 'http', url: 'https://example.test/mcp' }], templates: [] } }));
});

test('rich hub composer restores files, menus, mentions, previews and immutable submission', async ({ page }) => {
  await gotoHome(page);

  await dropFile(page, 'brief.txt', 'text/plain', 'payload-proof');
  await expect(page.getByTestId('home-hero-staged-files')).toContainText('brief.txt');

  await page.getByTestId('home-hero-input').evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['image-bytes'], 'pasted.png', { type: 'image/png' }));
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect(page.getByTestId('home-hero-staged-files')).toContainText('pasted.png');

  const previewButton = page.getByRole('button', { name: 'Preview pasted.png' });
  await previewButton.click();
  await page.locator('.staged-preview-modal').getByRole('button', { name: /close/i }).click();
  await previewButton.click();
  await page.locator('.staged-preview-modal').click({ position: { x: 8, y: 96 } });
  await expect(page.locator('.staged-preview-modal')).toHaveCount(0);
  await previewButton.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.staged-preview-modal')).toHaveCount(0);

  await page.getByRole('button', { name: /Remove pasted\.png/i }).click();
  await expect(page.getByTestId('home-hero-staged-files')).not.toContainText('pasted.png');
  const urlLifecycle = await page.evaluate(() => (window as unknown as { __qaObjectUrls: { created: string[]; revoked: string[] } }).__qaObjectUrls);
  expect(urlLifecycle.created.length).toBeGreaterThan(0);
  expect(urlLifecycle.revoked).toEqual(expect.arrayContaining(urlLifecycle.created));

  await page.getByTestId('home-hero-plus-trigger').click();
  await expect(page.getByTestId('composer-plus-attach')).toBeVisible();
  await page.getByRole('menuitem', { name: /Plugins/i }).hover();
  await expect(page.getByRole('menuitem', { name: /Add plugin/i })).toBeVisible();
  await page.getByRole('menuitem', { name: /^MCP$/i }).hover();
  await expect(page.getByRole('menuitem', { name: /Add MCP/i })).toBeVisible();
  await page.keyboard.press('Escape');

  const editor = page.getByTestId('home-hero-input');
  await editor.fill('@');
  const picker = page.getByTestId('home-hero-plugin-picker');
  await expect(picker).toBeVisible();
  for (const name of [/Design files/i, /Plugins/i, /Skills/i, /^MCP/i]) {
    const tab = picker.getByRole('tab', { name });
    await tab.click();
    await expect(picker.getByRole('option').first()).toBeVisible();
  }
  await picker.getByRole('tab', { name: /Plugins/i }).click();
  await editor.press('ArrowDown');
  await editor.press('ArrowUp');
  await editor.press('Enter');
  await expect(editor).toContainText('@QA Context Plugin');
  await editor.fill('@');
  await expect(picker).toBeVisible();
  await editor.press('Escape');
  await expect(picker).toBeHidden();
  await expect.poll(() => editor.evaluate((node) => document.activeElement === node || node.contains(document.activeElement))).toBe(true);

  await editor.fill('Create from the staged brief');
  let releaseProjectRequest!: () => void;
  const projectRequestRelease = new Promise<void>((resolve) => { releaseProjectRequest = resolve; });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await projectRequestRelease;
    await route.fallback();
  });
  const projectRequestPromise = page.waitForRequest((request) => request.url().endsWith('/api/projects') && request.method() === 'POST');
  const uploadRequestPromise = page.waitForRequest((request) => /\/api\/projects\/[^/]+\/upload$/.test(new URL(request.url()).pathname));
  await page.getByTestId('home-hero-submit').click();
  const projectRequest = await projectRequestPromise;
  const frozenFileRemove = page.getByRole('button', { name: /Remove brief\.txt/i });
  await expect(frozenFileRemove).toBeDisabled();
  await frozenFileRemove.evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByTestId('home-hero-staged-files')).toContainText('brief.txt');
  releaseProjectRequest();
  const uploadRequest = await uploadRequestPromise;
  expect(projectRequest.postDataJSON().pendingPrompt).toBe('Create from the staged brief');
  expect(uploadRequest.postData() ?? '').toContain('brief.txt');
  expect(uploadRequest.postData() ?? '').toContain('payload-proof');

  await page.screenshot({ path: 'D:/readable-studio/.omo/evidence/task-5/rich-composer.png', fullPage: true });
});

test('failed file-only upload stays on Home with a visible error and retained files', async ({ page }) => {
  await page.route(/\/api\/projects\/[^/]+\/upload$/, (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'INTERNAL_ERROR', error: 'qa upload failure' }),
  }));
  await gotoHome(page);

  await dropFile(page, 'upload-failure.txt', 'text/plain', 'must-be-retained');
  await page.getByTestId('home-hero-submit').click();

  const error = page.locator('.home-hero__error[role="alert"]');
  await expect(error).toContainText('No attachments were uploaded.');
  await expect(error).toContainText('upload-failure.txt');
  await expect(error).toContainText('Files remain attached');
  await expect(page.getByTestId('home-hero-staged-files')).toContainText('upload-failure.txt');
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('oversized drop is rejected visibly and specifically', async ({ page }) => {
  await gotoHome(page);
  await page.getByTestId('home-hero-input').evaluate((target) => {
    const file = new File(['x'], 'too-large.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 + 1 });
    const transfer = new DataTransfer(); transfer.items.add(file);
    target.closest('.home-hero__input-card')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  const error = page.locator('.home-hero__error[role="alert"]');
  await expect(error).toContainText('too-large.bin');
  await expect(error).toContainText('200 MiB');
  await expect(page.getByTestId('home-hero-staged-files')).toHaveCount(0);
});
