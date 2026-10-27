import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ChatRequest } from '@readable-studio/contracts';
import { createFakeAgentRuntimes } from '@/fake-agents';
import { addStorageInitScript } from '@/playwright/storage-init';
import { T } from '@/timeouts';

const selection = { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } } };
let savedConfig: Record<string, unknown>;
let config: Record<string, unknown>;

test.beforeAll(async ({ request }) => {
  const response = await request.get('/api/app-config');
  expect(response.ok(), await response.text()).toBe(true);
  savedConfig = ((await response.json()) as { config: Record<string, unknown> }).config;
  const { codex } = await createFakeAgentRuntimes({ root: join(tmpdir(), `mention-regressions-${randomUUID()}`), runtimeIds: ['codex'] });
  config = {
    ...savedConfig, ...selection, enabledAgentIds: ['codex'], skillId: null, designSystemId: null,
    onboardingCompleted: true, privacyDecisionAt: 1,
    telemetry: { metrics: false, content: false, artifactManifest: false },
    agentCliEnv: { codex: codex.env },
  };
  const configured = await request.put('/api/app-config', { data: config });
  expect(configured.ok(), await configured.text()).toBe(true);
});

test.beforeEach(async ({ page }) => {
  test.setTimeout(T.xlong);
  await addStorageInitScript(page, value => {
    localStorage.setItem('readable-studio:config', JSON.stringify(value));
    localStorage.setItem('readable-studio:locale', 'en');
    localStorage.setItem('readable-studio:locale-source', 'manual');
    localStorage.setItem('readable-studio:welcome-modal-shown', '1');
  }, config);
});

test.afterAll(async ({ request }) => {
  if (!savedConfig) return;
  const restored = await request.put('/api/app-config', { data: savedConfig });
  expect(restored.ok(), await restored.text()).toBe(true);
});

async function createProject(request: APIRequestContext) {
  const projectId = randomUUID();
  const response = await request.post('/api/projects', { data: {
    id: projectId, name: 'Mention regression audit', skillId: null, designSystemId: null,
    metadata: { kind: 'prototype' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  const { conversationId } = await response.json() as { conversationId: string };
  const selected = await request.patch(`/api/projects/${projectId}/conversations/${conversationId}`, { data: { selection } });
  expect(selected.ok(), await selected.text()).toBe(true);
  const seeded = await request.put(`/api/projects/${projectId}/conversations/${conversationId}/messages/mention-regression-start`, { data: {
    id: 'mention-regression-start', role: 'assistant', agentId: 'codex', content: 'Choose a reference for the next request.',
    runId: 'fixture', runStatus: 'succeeded', createdAt: Date.now(), endedAt: Date.now(), events: [],
  } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return { projectId, url: `/projects/${projectId}/conversations/${conversationId}` };
}

async function sendRequest(page: Page, projectId: string) {
  const sent = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/runs'
    && (request.postDataJSON() as ChatRequest).projectId === projectId);
  const accepted = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/runs'
    && (response.request().postDataJSON() as ChatRequest).projectId === projectId);
  await page.getByTestId('chat-send').click();
  const [request, response] = await Promise.all([sent, accepted]);
  expect(response.status(), await response.text()).toBe(202);
  return request.postDataJSON() as ChatRequest;
}

test('[P1] focused option Enter confirms the preview reached by ArrowDown', async ({ page, request }, testInfo) => {
  const project = await createProject(request);
  try {
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input');
    await expect(editor).toBeVisible();
    await editor.fill('Use @');
    const picker = page.getByTestId('mention-popover');
    await picker.getByRole('tab', { name: 'Skills', exact: true }).click();
    const options = picker.locator('[role="option"][data-resource-kind="skill"]');
    await expect(options.nth(1)).toBeVisible();
    const first = options.nth(0);
    const firstId = await first.getAttribute('data-resource-id');
    const secondId = await options.nth(1).getAttribute('data-resource-id');
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(picker.getByTestId('mention-preview-detail')).toHaveAttribute('data-resource-id', secondId!);
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editor.locator('[data-mention-id]')).toHaveCount(1);
    await expect(editor.locator('[data-mention-id]')).toHaveAttribute('data-mention-id', secondId!);
    await page.screenshot({ path: testInfo.outputPath('keyboard-confirmed.png') });
    const body = await sendRequest(page, project.projectId);
    expect(body.skillIds).toEqual([secondId]);
    await testInfo.attach('request-binding', { contentType: 'application/json', body: JSON.stringify(body, null, 2) });
  } finally {
    await page.close();
    const deleted = await request.delete(`/api/projects/${project.projectId}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});

for (const kind of ['skill', 'template'] as const) {
  test(`[P1] a saved ${kind} draft restores one confirmed occurrence and leaves the identical pending query plain`, async ({ page, request }, testInfo) => {
    const project = await createProject(request);
    try {
      await page.goto(project.url);
      const editor = page.getByTestId('chat-composer-input');
      await expect(editor).toBeVisible();
      await editor.fill('Use @');
      const picker = page.getByTestId('mention-popover');
      await picker.getByRole('tab', { name: kind === 'skill' ? 'Skills' : 'Templates', exact: true }).click();
      const option = picker.locator(`[role="option"][data-resource-kind="${kind}"]`).first();
      await expect(option).toBeVisible();
      const resourceId = await option.getAttribute('data-resource-id');
      await option.click();
      await picker.getByTestId('mention-preview-use').click();
      const pill = editor.locator('[data-mention-id]');
      await expect(pill).toHaveCount(1);
      const token = (await pill.innerText()).trim();
      expect(token).toBeTruthy();
      await editor.focus();
      await editor.press('Control+End');
      await page.keyboard.insertText(` and ${token}`);
      await expect(editor.locator('[data-mention-id]')).toHaveCount(1);
      await page.keyboard.press('Escape');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(editor).toBeVisible();
      await expect(editor.locator('[data-mention-id]')).toHaveCount(1);
      await expect(editor.locator('[data-mention-id]')).toHaveAttribute('data-mention-id', resourceId!);
      await expect(editor).toContainText(`${token} and ${token}`);
      await page.screenshot({ path: testInfo.outputPath('restored-draft.png') });
      const body = await sendRequest(page, project.projectId);
      expect(body.skillIds).toEqual([resourceId]);
      expect(body.currentPrompt?.split(token)).toHaveLength(3);
      await testInfo.attach('request-binding', { contentType: 'application/json', body: JSON.stringify(body, null, 2) });
    } finally {
      await page.close();
      const deleted = await request.delete(`/api/projects/${project.projectId}`);
      expect(deleted.ok(), await deleted.text()).toBe(true);
    }
  });
}
