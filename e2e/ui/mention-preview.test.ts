import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { ChatRequest, DesignTemplateSummary, SkillSummary } from '@readable-studio/contracts';
import { routeAgents } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { observeComposerIme } from '@/playwright/composer-ime';
import { T } from '@/timeouts';

// These tests exercise the production editor, picker and outgoing HTTP payload.
// Catalogue/apply/run responses are deterministic fixtures; no provider runs.
const selection = { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'fixture-model' } } };
const plugins = Array.from({ length: 12 }, (_, index) => {
  const title = index === 0 ? 'QA Deck Builder' : index === 1 ? 'QA Report Writer' : `QA Plugin ${String(index + 1).padStart(2, '0')}`;
  const id = `qa-mention-plugin-${index + 1}`;
  return {
    id, title, version: '1.0.0', sourceKind: 'bundled', source: `fixture/${id}`, fsPath: `fixture/${id}`,
    trust: 'bundled', installedAt: 1, updatedAt: 1, capabilitiesGranted: ['prompt:inject'],
    manifest: {
      name: id, title, version: '1.0.0', description: `${title}의 작업 설명입니다.`,
      readable: {
        kind: 'scenario', taskKind: 'new-generation', mode: 'prototype', inputs: [],
        useCase: { query: '' }, visualReference: { characteristics: ['QA restrained editorial layout'] },
      },
    },
  };
});
const skills: SkillSummary[] = [{
  id: 'qa-korean-writing', name: 'QA Korean Writing', description: '한국어 문장을 자연스럽게 다듬습니다.',
  triggers: ['한국어', '다듬기'], mode: 'prototype', previewType: 'none', designSystemRequired: false,
  defaultFor: [], upstream: null, hasBody: true, examplePrompt: '', aggregatesExamples: false,
}];
const templates: DesignTemplateSummary[] = [{
  ...skills[0]!, id: 'qa-monthly-template', name: 'QA Monthly Report', description: '월간 실적 보고서 템플릿',
  mode: 'template', previewType: 'html', source: 'user', userImported: true, templateType: 'deck', cover: 'cover.html',
  thumbnail: { status: 'ready', source: 'zip', updatedAt: '2026-10-26T00:00:00.000Z' },
}];

type ApplyMode = 'success' | 'failure' | 'held';
interface Fixture {
  applyRequests: string[];
  runRequests: ChatRequest[];
  projectPatches: Record<string, unknown>[];
  setApplyMode(mode: ApplyMode): void;
  releaseApply(): void;
}

async function installFixtures(page: Page): Promise<Fixture> {
  const config = { ...selection, theme: 'system', onboardingCompleted: true, privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } };
  await addStorageInitScript(page, value => {
    localStorage.setItem('readable-studio:config', JSON.stringify(value));
    localStorage.setItem('readable-studio:locale', 'ko');
    localStorage.setItem('readable-studio:locale-source', 'manual');
    localStorage.setItem('readable-studio:welcome-modal-shown', '1');
  }, config);
  await routeAgents(page, [{ id: 'codex', name: 'Codex', bin: 'fixture-agent', available: true, version: 'fixture', models: [{ id: 'fixture-model', label: 'Fixture model' }] }]);
  await page.route('**/api/app-config', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { config } });
    else await route.continue();
  });
  await page.route('**/api/plugins', route => route.fulfill({ json: { plugins } }));
  await page.route('**/api/skills', route => route.fulfill({ json: { skills } }));
  await page.route('**/api/mcp/servers', route => route.fulfill({ json: { servers: [{ id: 'qa-mention-mcp', label: 'QA MCP', enabled: true, transport: 'stdio', command: 'fixture-mcp' }] } }));
  await page.route('**/api/design-templates**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/design-templates') { await route.fulfill({ json: { designTemplates: templates } }); return; }
    if (path === '/api/design-templates/qa-monthly-template') {
      await route.fulfill({ json: { ...templates[0], body: '# QA monthly report\nUse the authored 1280 × 720 pages.' } }); return;
    }
    if (path === '/api/design-templates/qa-monthly-template/thumbnail') {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#ece8df"/><text x="80" y="180" font-size="54">QA Monthly Report</text></svg>' }); return;
    }
    if (path === '/api/design-templates/qa-monthly-template/pages/cover.html') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;width:1280px;height:720px"><h1>QA Monthly Report</h1></body></html>' }); return;
    }
    await route.continue();
  });
  const applyRequests: string[] = [];
  const runRequests: ChatRequest[] = [];
  const projectPatches: Record<string, unknown>[] = [];
  let mode: ApplyMode = 'success';
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  await page.route('**/api/plugins/*/apply', async route => {
    const id = new URL(route.request().url()).pathname.split('/')[3]!;
    applyRequests.push(id);
    const currentMode = mode;
    if (currentMode === 'held') await pending;
    if (currentMode === 'failure') { await route.fulfill({ status: 503, json: { error: 'Fixture plugin apply failed' } }); return; }
    const plugin = plugins.find(item => item.id === id)!;
    const item = { kind: 'plugin', id, label: plugin.title };
    await route.fulfill({ json: {
      query: '', contextItems: [item], inputs: [], assets: [], mcpServers: [], projectMetadata: {}, trust: 'trusted', capabilitiesGranted: [], capabilitiesRequired: [],
      appliedPlugin: {
        snapshotId: `qa-snapshot-${id}`, pluginId: id, pluginTitle: plugin.title, pluginVersion: '1.0.0',
        manifestSourceDigest: 'a'.repeat(64), inputs: {}, resolvedContext: { items: [item] }, capabilitiesGranted: [],
        capabilitiesRequired: [], assetsStaged: [], taskKind: 'new-generation', appliedAt: 1, mcpServers: [], status: 'fresh',
      },
    } });
  });
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    runRequests.push(route.request().postDataJSON() as ChatRequest);
    await route.fulfill({ status: 202, json: { runId: `qa-mention-run-${runRequests.length}` } });
  });
  await page.route('**/api/runs/qa-mention-run-*/events*', route => route.fulfill({
    contentType: 'text/event-stream', body: 'event: end\ndata: {"code":0,"status":"succeeded"}\n\n',
  }));
  page.on('request', request => {
    if (request.method() === 'PATCH' && /^\/api\/projects\/[^/]+$/.test(new URL(request.url()).pathname)) projectPatches.push(request.postDataJSON() as Record<string, unknown>);
  });
  return {
    applyRequests, runRequests, projectPatches,
    setApplyMode(next) {
      release?.(); mode = next;
      if (next === 'held') pending = new Promise<void>(resolve => { release = resolve; });
      else { pending = undefined; release = undefined; }
    },
    releaseApply() { release?.(); },
  };
}

async function createProject(request: APIRequestContext) {
  const id = randomUUID();
  const created = await request.post('/api/projects', { data: { id, name: 'Mention preview QA', skillId: null, designSystemId: null, metadata: { kind: 'prototype' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const { conversationId } = await created.json() as { conversationId: string };
  const patched = await request.patch(`/api/projects/${id}/conversations/${conversationId}`, { data: { selection } });
  expect(patched.ok(), await patched.text()).toBe(true);
  const seeded = await request.put(`/api/projects/${id}/conversations/${conversationId}/messages/mention-preview-fixture`, { data: {
    id: 'mention-preview-fixture', role: 'assistant', agentId: 'codex', content: '자료를 선택하여 요청을 작성하세요.',
    runId: 'fixture', runStatus: 'succeeded', createdAt: Date.now(), endedAt: Date.now(), events: [],
  } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return { id, conversationId, url: `/projects/${id}/conversations/${conversationId}` };
}

async function appendQuery(page: Page, editor: Locator, query: string) {
  await editor.focus(); await editor.press('Control+End');
  await page.keyboard.insertText((await editor.innerText()).trim() ? ` @${query}` : `@${query}`);
}

async function previewAndUse(picker: Locator, title: string) {
  const option = picker.getByRole('option').filter({ hasText: title }).first();
  await expect(option).toBeVisible(); await option.click();
  await expect(picker.getByTestId('mention-preview-detail')).toContainText(title);
  await picker.getByTestId('mention-preview-use').click();
  await expect(picker).toBeHidden();
}

test.use({ viewport: { width: 1280, height: 900 } });
test.beforeEach(() => { test.setTimeout(T.xlong * 3); });

for (const surface of ['project', 'home'] as const) {
  test(`[P1] ${surface} previews a multiword mention before use and preserves the middle caret and undo`, async ({ page, request }, testInfo) => {
    const fixture = await installFixtures(page);
    const project = surface === 'project' ? await createProject(request) : undefined;
    try {
      await page.goto(project?.url ?? '/');
      const editor = page.getByTestId(surface === 'project' ? 'chat-composer-input' : 'home-hero-input');
      const picker = page.getByTestId(surface === 'project' ? 'mention-popover' : 'home-hero-plugin-picker');
      await expect(editor).toBeVisible(); await editor.fill('앞문장 뒷문장'); await editor.press('Control+Home');
      for (let index = 0; index < 4; index++) await editor.press('ArrowRight');
      await page.keyboard.insertText('@QA Deck Builder');
      await expect(picker).toBeVisible();
      const original = await editor.innerText();
      await picker.getByRole('option').filter({ hasText: 'QA Deck Builder' }).first().click();
      await expect(picker.getByTestId('mention-preview-detail')).toContainText('QA Deck Builder');
      await page.screenshot({ path: testInfo.outputPath(`${surface}-preview-light.png`) });
      await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
      expect(fixture.applyRequests).toEqual([]);
      await picker.getByTestId('mention-preview-use').click();
      await expect(picker).toBeHidden();
      await expect(editor.locator('[data-mention-id]')).toHaveCount(1);
      await expect(editor).toContainText('앞문장'); await expect(editor).toContainText('뒷문장');
      await editor.press('Control+z');
      await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
      await expect(editor).toHaveText(original);
      await editor.press('Control+Shift+z');
      await expect(editor.locator('[data-mention-id]')).toHaveCount(1);
      await page.keyboard.insertText('이어서 ');
      const text = await editor.innerText();
      expect(text.indexOf('이어서')).toBeLessThan(text.indexOf('뒷문장'));
      const caret = await editor.evaluate(element => {
        const anchor = window.getSelection()?.anchorNode;
        return { inEditor: !!anchor && element.contains(anchor), inPill: !!anchor?.parentElement?.closest('[data-mention-id]') };
      });
      expect(caret).toEqual({ inEditor: true, inPill: false });
      await page.screenshot({ path: testInfo.outputPath(`${surface}-mention-middle.png`) });
      await editor.fill('@QA Deck Builder'); await expect(picker).toBeVisible();
      await page.setViewportSize({ width: 736, height: 900 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await testInfo.attach(`${surface}-picker-geometry`, { contentType: 'application/json', body: JSON.stringify(await picker.evaluate(element => {
        const layer = element.closest('.caret-floating-layer'); const action = element.querySelector('[data-testid="mention-preview-use"]');
        return { viewport: { width: window.innerWidth, height: window.innerHeight }, picker: element.getBoundingClientRect().toJSON(), layer: layer?.getAttribute('style'), action: action?.getBoundingClientRect().toJSON() };
      })) });
      await expect.poll(async () => (await picker.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
      await expect.poll(async () => { const bounds = await picker.boundingBox(); return bounds ? bounds.x + bounds.width : Infinity; }).toBeLessThanOrEqual(736);
      await expect(picker.getByTestId('mention-preview-use')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`${surface}-mention-736.png`) });
      const readPalette = () => page.getByTestId('mention-popover').evaluate(element => {
        const style = getComputedStyle(element); return { background: style.backgroundColor, text: style.color };
      });
      const lightPalette = await readPalette();
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
      await expect.poll(readPalette).not.toEqual(lightPalette);
      await testInfo.attach(`${surface}-picker-theme`, { contentType: 'application/json', body: JSON.stringify({ light: lightPalette, dark: await readPalette() }) });
      await expect(picker.getByTestId('mention-preview-use')).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`${surface}-mention-736-dark.png`) });
      await editor.press('Escape'); await expect(picker).toBeHidden();
    } finally { fixture.releaseApply(); if (project) await request.delete(`/api/projects/${project.id}`); }
  });
}

test('[P1] Home mention preview preserves template routing and visual-reference and MCP creation context', async ({ page }) => {
  const fixture = await installFixtures(page);
  try {
    // This scenario pins the browser's outgoing creation contract. The fixture
    // template is intentionally not registered in the real daemon catalogue.
    await page.route('**/api/sessions', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const workspace = { ...route.request().postDataJSON(), id: 'qa-home-mention-created', createdAt: 1, updatedAt: 1 };
      await route.fulfill({ json: { workspace, session: { id: 'qa-home-mention-conversation', projectId: workspace.id, title: workspace.name, sessionMode: 'design', createdAt: 1, updatedAt: 1 } } });
    });
    await page.goto('/');
    const editor = page.getByTestId('home-hero-input'); const picker = page.getByTestId('home-hero-plugin-picker');
    await appendQuery(page, editor, 'QA Deck Builder'); await previewAndUse(picker, 'QA Deck Builder');
    await appendQuery(page, editor, 'QA Monthly Report'); await previewAndUse(picker, 'QA Monthly Report');
    await appendQuery(page, editor, 'QA MCP'); await previewAndUse(picker, 'QA MCP');
    await page.keyboard.insertText(' 월간 실적을 정리해 주세요');
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions');
    await page.getByTestId('home-hero-submit').click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBe(true);
    const payload = response.request().postDataJSON() as { skillId?: string; metadata?: { visualReferences?: unknown[]; contextMcpServers?: unknown[] } };
    expect(payload.skillId).toBe('qa-monthly-template');
    expect(payload.metadata?.visualReferences).toEqual(expect.arrayContaining([expect.objectContaining({ characteristics: ['QA restrained editorial layout'] })]));
    expect(payload.metadata?.contextMcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'qa-mention-mcp' })]));
  } finally { fixture.releaseApply(); }
});

test('[P1] keyboard mention results stay visible and Escape leaves no selected context', async ({ page, request }, testInfo) => {
  const fixture = await installFixtures(page); const project = await createProject(request);
  try {
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input'); const picker = page.getByTestId('mention-popover');
    await editor.fill('@QA'); await expect(picker).toBeVisible();
    await expect.poll(() => picker.getByRole('option').count()).toBeGreaterThan(5);
    const count = await picker.getByRole('option').count();
    for (let index = 1; index < count; index++) await editor.press('ArrowDown');
    const active = picker.locator('[role="option"][aria-selected="true"]');
    await expect(active).toBeInViewport({ ratio: 1 });
    expect(await active.evaluate(element => {
      const box = element.getBoundingClientRect();
      let parent = element.parentElement;
      while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
      if (!parent) return true;
      const bounds = parent.getBoundingClientRect(); return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('keyboard-last-visible.png') });
    await editor.press('Escape'); await expect(picker).toBeHidden();
    await expect(editor).toHaveText('@QA'); await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
    expect(fixture.applyRequests).toEqual([]);
    await editor.fill('@zzzz-no-result'); await expect(picker).toBeVisible();
    await expect(picker.getByRole('option')).toHaveCount(0);
    await editor.press('Enter'); expect(fixture.runRequests).toEqual([]);
    await editor.press('Escape'); await expect(picker).toBeHidden();
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

test('[P1] template and skill mentions reach only the current request and preview the authored cover size', async ({ page, request }, testInfo) => {
  const fixture = await installFixtures(page); const project = await createProject(request);
  try {
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input'); const picker = page.getByTestId('mention-popover');
    await editor.fill('@QA Monthly Report'); await expect(picker).toBeVisible();
    await picker.getByRole('option').filter({ hasText: 'QA Monthly Report' }).click();
    const detail = picker.getByTestId('mention-preview-detail');
    await expect(detail).toHaveAttribute('data-resource-kind', 'template');
    const cover = detail.locator('img'); await expect(cover).toBeVisible();
    await expect(cover).toHaveJSProperty('naturalWidth', 1280); await expect(cover).toHaveJSProperty('naturalHeight', 720);
    const coverGeometry = await cover.evaluate(element => {
      const image = element as HTMLImageElement; const bounds = image.getBoundingClientRect();
      return { boxRatio: bounds.width / bounds.height, authoredRatio: image.naturalWidth / image.naturalHeight, fit: getComputedStyle(image).objectFit };
    });
    // A constrained preview may letterbox its authored image with object-fit.
    expect(Math.abs(coverGeometry.boxRatio - coverGeometry.authoredRatio) < 0.02 || ['contain', 'scale-down'].includes(coverGeometry.fit)).toBe(true);
    const templateGeometry = () => picker.evaluate(element => ({
      viewport: { width: innerWidth, height: innerHeight }, picker: element.getBoundingClientRect().toJSON(),
      layerStyle: element.closest('.caret-floating-layer')?.getAttribute('style'),
      layer: element.closest('.caret-floating-layer')?.getBoundingClientRect().toJSON(),
      cover: element.querySelector('img')?.getBoundingClientRect().toJSON(),
      action: element.querySelector('[data-testid="mention-preview-use"]')?.getBoundingClientRect().toJSON(),
    }));
    await testInfo.attach('template-after-cover-load', { contentType: 'application/json', body: JSON.stringify(await templateGeometry()) });
    await expect(picker.getByTestId('mention-preview-use')).toBeInViewport({ ratio: 1 });
    await testInfo.attach('template-action-visible', { contentType: 'application/json', body: JSON.stringify(await templateGeometry()) });
    await page.screenshot({ path: testInfo.outputPath('template-720-preview.png') });
    await picker.getByTestId('mention-preview-use').click(); await expect(picker).toBeHidden();
    await appendQuery(page, editor, 'QA Korean Writing'); await previewAndUse(picker, 'QA Korean Writing');
    expect(fixture.projectPatches.filter(body => 'skillId' in body)).toEqual([]);
    const persisted = await request.get(`/api/projects/${project.id}`); expect(persisted.ok()).toBe(true);
    expect(((await persisted.json()) as { project: { skillId?: string | null } }).project.skillId ?? null).toBeNull();
    await page.keyboard.insertText(' 자료를 정리해 주세요');
    await page.getByTestId('chat-send').click();
    await expect.poll(() => fixture.runRequests.length).toBe(1);
    expect(fixture.runRequests[0]?.skillIds).toEqual(expect.arrayContaining(['qa-monthly-template', 'qa-korean-writing']));
    await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

test('[P1] replacing undoing and removing a plugin keeps the outgoing snapshot consistent with the inline pill', async ({ page, request }) => {
  const fixture = await installFixtures(page); const project = await createProject(request);
  try {
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input'); const picker = page.getByTestId('mention-popover');
    await appendQuery(page, editor, 'QA Deck Builder'); await previewAndUse(picker, 'QA Deck Builder');
    await expect(editor.locator('.composer-inline-mention--plugin')).toHaveCount(1);
    await expect(page.locator('.staged-context--plugin')).toHaveCount(0);
    await appendQuery(page, editor, 'QA Report Writer'); await previewAndUse(picker, 'QA Report Writer');
    await expect(editor.locator('.composer-inline-mention--plugin')).toHaveCount(1);
    await expect(editor.locator('.composer-inline-mention--plugin')).toContainText('QA Report Writer');
    await editor.press('Control+z');
    await expect(editor.locator('.composer-inline-mention--plugin')).toContainText('QA Deck Builder');
    await page.getByTestId('chat-send').click();
    await expect.poll(() => fixture.runRequests.length).toBe(1);
    expect(fixture.runRequests[0]?.appliedPluginSnapshotId).toBe('qa-snapshot-qa-mention-plugin-1');
    await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
    await appendQuery(page, editor, 'QA Report Writer'); await previewAndUse(picker, 'QA Report Writer');
    await editor.press('Control+End');
    for (let count = 0; count < 3 && await editor.locator('[data-mention-id]').count(); count++) await editor.press('Backspace');
    await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
    await editor.fill('플러그인 없이 이어서 작성'); await page.getByTestId('chat-send').click();
    await expect.poll(() => fixture.runRequests.length).toBe(2);
    expect(fixture.runRequests[1]?.appliedPluginSnapshotId ?? null).toBeNull();
  } finally { fixture.releaseApply(); await request.delete(`/api/projects/${project.id}`); }
});

test('[P1] failed or pending plugin use preserves text and commits only after successful apply', async ({ page, request }) => {
  const fixture = await installFixtures(page); const project = await createProject(request);
  try {
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input'); const picker = page.getByTestId('mention-popover');
    await editor.fill('앞문장 뒷문장'); await editor.press('Control+Home');
    for (let index = 0; index < 4; index++) await editor.press('ArrowRight');
    await page.keyboard.insertText('@QA Deck Builder');
    await picker.getByRole('option').filter({ hasText: 'QA Deck Builder' }).click();
    const before = await editor.innerText(); fixture.setApplyMode('failure');
    await picker.getByTestId('mention-preview-use').click();
    await expect.poll(() => fixture.applyRequests.length).toBe(1);
    await expect(picker.getByRole('alert')).toContainText(/적용하지 못|실패|다시|오류|failed|retry/i);
    await expect(editor).toHaveText(before); await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
    fixture.setApplyMode('held'); await picker.getByTestId('mention-preview-use').click();
    await expect.poll(() => fixture.applyRequests.length).toBe(2);
    await expect(picker.getByTestId('mention-preview-use')).toBeDisabled();
    await expect(editor).toHaveText(before); await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
    fixture.releaseApply(); await expect(picker).toBeHidden();
    await expect(editor.locator('[data-mention-id]')).toHaveCount(1);
    await page.keyboard.insertText('이어서 ');
    const after = await editor.innerText(); expect(after.indexOf('이어서')).toBeLessThan(after.indexOf('뒷문장'));
  } finally { fixture.releaseApply(); await request.delete(`/api/projects/${project.id}`); }
});

test('[P1] file workspace-tab and MCP selections still reach the request through the preview picker', async ({ page, request }) => {
  const fixture = await installFixtures(page); const project = await createProject(request);
  try {
    const seeded = await request.post(`/api/projects/${project.id}/files`, { data: { name: 'qa-notes.md', content: '# QA notes\nA private fixture.' } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input'); const picker = page.getByTestId('mention-popover');
    await appendQuery(page, editor, 'qa-notes'); await previewAndUse(picker, 'qa-notes.md');
    await appendQuery(page, editor, '디자인 파일'); await previewAndUse(picker, '디자인 파일');
    await appendQuery(page, editor, 'QA MCP'); await previewAndUse(picker, 'QA MCP');
    await page.keyboard.insertText(' 이 자료로 작업해 주세요'); await page.getByTestId('chat-send').click();
    await expect.poll(() => fixture.runRequests.length).toBe(1);
    expect(fixture.runRequests[0]?.attachments).toContain('qa-notes.md');
    expect(fixture.runRequests[0]?.context?.mcpServerIds).toContain('qa-mention-mcp');
    expect(fixture.runRequests[0]?.context?.workspaceItems).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'workspace:design-files', kind: 'design-files' })]));
  } finally { await request.delete(`/api/projects/${project.id}`); }
});

test('[P1] Korean composition Enter does not commit a mention or send the request', async ({ page, request }, testInfo) => {
  const fixture = await installFixtures(page); const project = await createProject(request);
  try {
    await page.goto(project.url);
    const editor = page.getByTestId('chat-composer-input');
    await editor.fill('@'); await expect(page.getByTestId('mention-popover')).toBeVisible();
    const ime = await observeComposerIme(page, editor);
    try {
      for (const text of ['ㅎ', '하', '한']) await ime.update(text);
      await ime.composingEnter();
      await expect(editor.locator('[data-mention-id]')).toHaveCount(0);
      expect(fixture.applyRequests).toEqual([]); expect(fixture.runRequests).toEqual([]);
      await ime.commit('한');
      const snapshot = await ime.snapshot(); expect(snapshot.text).toBe('@한');
      testInfo.annotations.push({ type: 'ime-trust-capability', description: `CDP browser composition, not physical Windows IME. compositionend.isTrusted=${snapshot.trustedCompositionEnd}.` });
    } finally { await ime.dispose(); }
  } finally { await request.delete(`/api/projects/${project.id}`); }
});
