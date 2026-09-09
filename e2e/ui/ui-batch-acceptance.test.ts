import { expect, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, CreateProjectResponse, MessagesResponse, ProjectFileResponse } from '@readable-studio/contracts';
import { randomUUID } from 'node:crypto';
import { HELD_QUESTION_RUN } from '@/fake-agents';
import { gateQuestionHydration } from '@/playwright/question-hydration';
import { addStorageInitScript } from '@/playwright/storage-init';
import { FORM_ID, HTML, MODEL, PREVIEW, checked, dropFiles, isApi, questionsCli, screenshot, terminalMessage, test } from '@/playwright/ui-batch';
import { T } from '@/timeouts';

// One acceptance entry point for this UI batch. All persistence and agent runs
// use the real daemon; only discovery and explicit failure injection are routed.
// No suite retry can turn a timing-dependent acceptance into a passing result.
test.describe.configure({ retries: 0, timeout: T.xlong * 2 });

for (const width of [375, 768, 1280]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`[P1] Questions ${width}px ${theme}: primary form, secondary assumptions, keyboard and hydration`, async ({ page, request, batch }) => {
      await page.setViewportSize({ width, height: 900 });
      await batch.configure({ theme });
      const { id, conversationId } = await batch.create({ kind: 'prototype', brief: {
        assumptions: [{ id: 'audience', label: 'Audience', value: 'Reviewers', provenance: 'inferred' }], updatedAt: 1,
      } });
      await batch.seedForm(id, conversationId);
      const other = await checked(await request.post(`/api/projects/${id}/conversations`, { data: { title: 'Other conversation queue' } }));
      const otherId = (await other.json() as { conversation: { id: string } }).conversation.id;
      const queueKey = `readable:chat-queued-sends:${id}:v1`;
      const queued = [{ id: randomUUID(), conversationId: otherId, prompt: 'Keep the unrelated queue',
        attachments: [], commentAttachments: [], createdAt: Date.now(), meta: { sessionMode: 'design' } }];
      await addStorageInitScript(page, ({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
      }, { key: queueKey, value: queued });
      const gate = await gateQuestionHydration(page, id, conversationId);
      try {
        const held = await gate.next(() => page.goto(`/projects/${id}/conversations/${conversationId}`));
        await page.getByTestId('questions-tab').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('tab', { name: /^Brief$/ })).toHaveCount(0);
        const panel = page.getByTestId('questions-panel');
        const form = panel.locator(`[data-form-id="${FORM_ID}"]`);
        const primary = panel.locator('.questions-panel__editor--primary');
        const assumptions = panel.locator('.questions-panel__groups');
        const next = panel.locator('.questions-continue');
        await expect(form).toBeVisible();
        await expect(assumptions).toBeVisible();
        await expect(next).toBeDisabled();
        expect(await primary.evaluate((node) => {
          const secondary = node.parentElement!.querySelector('.questions-panel__groups')!;
          return Boolean(node.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING)
            && node.getBoundingClientRect().bottom <= secondary.getBoundingClientRect().top;
        })).toBe(true);
        expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await expect(primary).not.toHaveCSS('box-shadow', 'none');
        await expect(panel.getByTestId('questions-influence')).toHaveAttribute('data-count', '1');
        await expect(panel.getByTestId('questions-influence')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

        const select = form.getByRole('combobox', { name: 'Delivery format' });
        await select.focus();
        await select.press('ArrowDown');
        const list = page.getByRole('listbox', { name: 'Delivery format' });
        const html = list.getByRole('option', { name: 'HTML', exact: true });
        const markdown = list.getByRole('option', { name: 'Markdown', exact: true });
        const slides = list.getByRole('option', { name: 'Slides', exact: true });
        await expect(html).toBeFocused();
        await page.keyboard.press('End');
        await expect(slides).toBeFocused();
        await page.keyboard.press('Home');
        await expect(html).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(markdown).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(html).toBeFocused();
        await page.keyboard.press('m');
        await expect(markdown).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(select).toHaveAttribute('data-value', 'markdown');
        await expect(select).toBeFocused();
        await select.press('Space');
        await expect(markdown).toBeFocused();
        await page.keyboard.press('s');
        await expect(slides).toBeFocused();
        const box = await list.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.keyboard.press('Escape');
        await expect(list).toHaveCount(0);
        await expect(select).toBeFocused();
        await expect(select).toHaveAttribute('data-value', 'markdown');
        const audience = form.getByRole('textbox', { name: 'Audience', exact: true });
        await audience.fill('Reviewers\nKeep this line');
        const queueBytes = await page.evaluate((key) => localStorage.getItem(key), queueKey);
        await held.fail();
        const retry = panel.getByRole('button', { name: 'Retry run check', exact: true });
        await expect(retry).toBeVisible();
        const retryRead = await gate.next(() => retry.evaluate((node) => {
          for (let index = 0; index < 20; index++) (node as HTMLButtonElement).click();
        }));
        await expect(next).toBeDisabled();
        await expect(audience).toBeEditable();
        await expect(select).toHaveAttribute('data-value', 'markdown');
        expect(gate.requestCount).toBe(2);
        expect(gate.maxInflight).toBe(1);
        expect((await retryRead.succeed()).runs).toEqual([]);
        await expect(next).toBeEnabled();
        await expect(audience).toHaveValue('Reviewers\nKeep this line');
        expect(await page.evaluate((key) => localStorage.getItem(key), queueKey)).toBe(queueBytes);
        expect(batch.runs).toHaveLength(0);
        await screenshot(page, `questions-${width}-${theme}`);

        // Both CLI commands address the same daemon-valid project as the UI.
        expect((await questionsCli('get', id)).brief.assumptions).toContainEqual(expect.objectContaining({ id: 'audience', value: 'Reviewers' }));
        expect((await questionsCli('set', id, 'audience', 'CLI reviewers')).brief.assumptions)
          .toContainEqual(expect.objectContaining({ id: 'audience', value: 'CLI reviewers', provenance: 'stated' }));
        expect((await questionsCli('get', id)).brief.assumptions)
          .toContainEqual(expect.objectContaining({ id: 'audience', value: 'CLI reviewers', provenance: 'stated' }));
        await gate.dispose();
        await page.reload();
        await page.getByTestId('questions-tab').click();
        await expect(panel.getByRole('listitem').filter({ hasText: 'CLI reviewers' })).toBeVisible();
        await expect(select).toHaveAttribute('data-value', 'markdown');
        await expect(audience).toHaveValue('Reviewers\nKeep this line');
      } finally {
        await gate.dispose();
      }
    });
  }
}

test('[P1] blocked Enter and Send preserve draft and attachment bytes, then fake CLI sends exactly once', async ({ page, request, batch }) => {
  await batch.configure({ unselected: true });
  const { id, conversationId } = await batch.create();
  await page.goto(`/projects/${id}/conversations/${conversationId}`);
  const composer = page.getByTestId('chat-composer');
  const input = page.getByTestId('chat-composer-input');
  const send = page.getByTestId('chat-send');
  const staged = composer.getByTestId('staged-contexts');
  const attachment = staged.getByRole('button', { name: 'Remove keep-me.txt', exact: true });
  const attachmentOrders = staged.getByLabel(/^Attachment \d+$/);
  const draft = 'Preserve this exact draft until the model is selected';
  const bytes = Buffer.from('Acceptance attachment\r\n\u0000exact bytes\r\n', 'utf8');
  const [upload] = await Promise.all([
    page.waitForResponse((response) => isApi(response, 'POST', `/api/projects/${id}/upload`), { timeout: T.long }),
    page.getByTestId('chat-file-input').setInputFiles({ name: 'keep-me.txt', mimeType: 'text/plain', buffer: bytes }),
  ]);
  await checked(upload);
  const uploaded = (await upload.json() as { files: Array<{ path: string; originalName?: string; name: string }> }).files;
  expect(uploaded).toHaveLength(1);
  const file = uploaded[0]!;
  await expect(attachment).toBeVisible();
  await expect(staged.getByText('keep-me.txt', { exact: true })).toHaveAttribute('title', file.path);
  await expect(attachmentOrders).toHaveCount(1);
  await input.fill(draft);
  await expect(send).toBeEnabled();
  // The exact guard event distinguishes a genuine rejection from a disabled
  // button or another early return. Capture it before either user action.
  await page.evaluate(() => {
    document.documentElement.dataset.acceptanceGuardCount = '0';
    window.addEventListener('readable:model-selection-required', () => {
      const root = document.documentElement;
      root.dataset.acceptanceGuardCount = String(Number(root.dataset.acceptanceGuardCount) + 1);
    });
  });
  for (const [index, trigger] of [() => input.press('Enter'), () => send.click()].entries()) {
    await trigger();
    await expect(page.locator('html')).toHaveAttribute('data-acceptance-guard-count', String(index + 1));
    await expect(page.getByTestId('inline-model-switcher-model-toast')).toBeVisible();
    await expect(input).toHaveText(draft);
    await expect(attachment).toHaveCount(1);
    await expect(attachment).toBeVisible();
    await expect(staged.getByText('keep-me.txt', { exact: true })).toHaveAttribute('title', file.path);
    await expect(attachmentOrders).toHaveCount(1);
    const raw = await checked(await request.get(`/api/projects/${id}/raw/${encodeURIComponent(file.path)}`));
    expect(await raw.body()).toEqual(bytes);
    expect(batch.runs).toHaveLength(0);
    const messages = await checked(await request.get(`/api/projects/${id}/conversations/${conversationId}/messages`));
    expect((await messages.json() as MessagesResponse).messages).toHaveLength(0);
  }
  await composer.getByTestId('inline-model-switcher-agent-trigger').click();
  await page.getByTestId('inline-model-switcher-agent-codex').click();
  await composer.getByTestId('inline-model-switcher-model-trigger').click();
  await page.getByTestId(`inline-model-switcher-model-option-${MODEL}`).click();
  const [started, saved] = await Promise.all([
    page.waitForResponse((response) => isApi(response, 'POST', '/api/runs'), { timeout: T.long }),
    page.waitForResponse((response) => terminalMessage(response, id, conversationId), { timeout: T.long }),
    send.click(),
  ]);
  await checked(started);
  await checked(saved);
  await expect(input).toHaveText('');
  // Design Files is persistent run context, not a submitted attachment.
  await expect(attachment).toHaveCount(0);
  await expect(staged.getByText('keep-me.txt', { exact: true })).toHaveCount(0);
  await expect(attachmentOrders).toHaveCount(0);
  await expect(page.frameLocator(PREVIEW).getByRole('heading', { name: 'Fake Agent Runtime codex' })).toBeVisible();
  expect(batch.runs).toHaveLength(1);
  expect(batch.runs[0]).toMatchObject({ projectId: id, conversationId, agentId: 'codex', currentPrompt: draft,
    attachments: [file.path], model: MODEL });
  const messages = await checked(await request.get(`/api/projects/${id}/conversations/${conversationId}/messages`));
  const userMessages = (await messages.json() as MessagesResponse).messages.filter((message) => message.role === 'user');
  expect(userMessages).toHaveLength(1);
  expect(userMessages[0]).toMatchObject({ content: draft,
    attachments: [expect.objectContaining({ name: 'keep-me.txt', path: file.path, size: bytes.length })] });
  // A new draft after the terminal barrier must not be erased by a late reset.
  await input.fill('Next draft');
  await page.getByTestId('design-files-tab').click();
  await expect(input).toHaveText('Next draft');
  expect(batch.runs).toHaveLength(1);
});

test('[P1] active hydration retry keeps an answer queued and promotes it once after the held CLI releases', async ({ page, request, batch }) => {
  await batch.configure();
  const { id, conversationId } = await batch.create();
  await page.goto(`/projects/${id}/conversations/${conversationId}`);
  await page.getByTestId('chat-composer-input').fill(HELD_QUESTION_RUN.prompt);
  const [started, formSaved] = await Promise.all([
    page.waitForResponse((response) => isApi(response, 'POST', '/api/runs'), { timeout: T.long }),
    page.waitForResponse((response) => response.request().method() === 'PUT'
      && new URL(response.url()).pathname.startsWith(`/api/projects/${id}/conversations/${conversationId}/messages/`)
      && (response.request().postDataJSON() as ChatMessage).content.includes(`id="${HELD_QUESTION_RUN.formId}"`), { timeout: T.long }),
    page.getByTestId('chat-send').click(),
  ]);
  await checked(started);
  await checked(formSaved);
  const runId = (await started.json() as { runId: string }).runId;
  const panel = page.getByTestId('questions-panel');
  await page.getByTestId('questions-tab').click();
  await panel.getByRole('radio', { name: 'Desktop web', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Audience details', exact: true }).fill('Queued reviewers');
  await panel.locator('.questions-continue').click();
  await expect(page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row')).toHaveCount(1);
  const key = `readable:chat-queued-sends:${id}:v1`;
  const before = await page.evaluate((queueKey) => localStorage.getItem(queueKey), key);
  const gate = await gateQuestionHydration(page, id, conversationId);
  try {
    const held = await gate.next(() => page.reload());
    await page.getByTestId('questions-tab').click();
    await held.fail();
    const retry = panel.getByRole('button', { name: 'Retry run check', exact: true });
    const recovery = await gate.next(() => retry.click());
    const authoritative = await recovery.succeed();
    expect(authoritative.runs).toEqual([expect.objectContaining({ id: runId, status: 'running' })]);
    await expect(panel.locator('.question-form')).toHaveClass(/question-form-locked/);
    await expect(panel.getByRole('textbox', { name: 'Audience details', exact: true })).toHaveValue('Queued reviewers');
    expect(await page.evaluate((queueKey) => localStorage.getItem(queueKey), key)).toBe(before);
    expect(batch.runs).toHaveLength(1);
    const promoted = (response: Response) => isApi(response, 'POST', '/api/runs')
      && (response.request().postDataJSON() as ChatRequest).currentPrompt !== HELD_QUESTION_RUN.prompt;
    const [promotion, saved] = await Promise.all([
      page.waitForResponse(promoted, { timeout: T.long }),
      page.waitForResponse((response) => terminalMessage(response, id, conversationId)
        && (response.request().postDataJSON() as ChatMessage).runId !== runId, { timeout: T.long }),
      request.post(`/api/projects/${id}/files`, { data: { name: HELD_QUESTION_RUN.releaseFile, content: HELD_QUESTION_RUN.releaseToken } }).then(checked),
    ]);
    await checked(promotion);
    await checked(saved);
    await expect(page.getByTestId('chat-queued-send-strip')).toHaveCount(0);
    expect(batch.runs).toHaveLength(2);
    expect(batch.runs[1]?.currentPrompt).toContain('Queued reviewers');
    expect(JSON.parse(await page.evaluate((queueKey) => localStorage.getItem(queueKey), key) ?? '[]')).toEqual([]);
  } finally {
    await gate.dispose();
  }
});

test('[P1] three closable tabs restore right, left and Design Files focus; permanent tabs and pending styles cannot close', async ({ page, request, batch }) => {
  await batch.configure();
  const { id, conversationId } = await batch.create({ kind: 'prototype', brief: {
    assumptions: [{ id: 'audience', label: 'Audience', value: 'Reviewers', provenance: 'inferred' }], updatedAt: 1,
  } });
  for (const name of ['alpha.html', 'beta.html', 'gamma.html']) {
    await checked(await request.post(`/api/projects/${id}/files`, { data: { name, content: HTML } }));
  }
  await checked(await request.put(`/api/projects/${id}/tabs`, { data: { tabs: ['alpha.html', 'beta.html', 'gamma.html'], active: 'beta.html', updatedAt: Date.now() } }));
  await page.goto(`/projects/${id}/conversations/${conversationId}`);
  const alpha = page.getByRole('tab', { name: 'alpha.html', exact: true });
  const beta = page.getByRole('tab', { name: 'beta.html', exact: true });
  const gamma = page.getByRole('tab', { name: 'gamma.html', exact: true });
  const files = page.getByTestId('design-files-tab');
  await expect(alpha).toBeVisible();
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  await expect(gamma).toBeVisible();
  await beta.getByRole('button', { name: 'Close tab', exact: true }).click();
  await expect(beta).toHaveCount(0);
  await expect(gamma).toHaveAttribute('aria-selected', 'true');
  await expect(gamma).toBeFocused();
  await gamma.click({ button: 'middle' });
  await expect(gamma).toHaveCount(0);
  await expect(alpha).toHaveAttribute('aria-selected', 'true');
  await expect(alpha).toBeFocused();
  await page.keyboard.press('Control+w');
  await expect(alpha).toHaveCount(0);
  await expect(files).toHaveAttribute('aria-selected', 'true');
  await expect(files).toBeFocused();
  for (const permanent of [files, page.getByTestId('questions-tab')]) {
    await expect(permanent.getByRole('button', { name: 'Close tab', exact: true })).toHaveCount(0);
    await permanent.click();
    await permanent.click({ button: 'middle' });
    await page.keyboard.press('Control+w');
    await expect(permanent).toBeVisible();
  }

  // Reopen through the route, then stage a style in the actual iframe inspector.
  await page.goto(`/projects/${id}/files/alpha.html`);
  await page.getByTestId('manual-edit-mode-toggle').click();
  const title = page.frameLocator(PREVIEW).locator('[data-readable-id="acceptance-title"]');
  await title.click();
  const inspector = page.locator('.manual-edit-left-inspector');
  await inspector.getByLabel('Font size', { exact: true }).fill('48');
  await expect(title).toHaveCSS('font-size', '48px');
  expect(await (await checked(await request.get(`/api/projects/${id}/files/alpha.html`))).text()).toBe(HTML);
  for (const close of [
    () => alpha.getByRole('button', { name: 'Close tab', exact: true }).click(),
    () => alpha.click({ button: 'middle' }),
    async () => { await alpha.focus(); await page.keyboard.press('Control+w'); },
  ]) {
    await close();
    await expect(alpha).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.readable-toast[role="alert"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Discard changes', exact: true })).toBeEnabled();
  }
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await alpha.getByRole('button', { name: 'Close tab', exact: true }).click();
  await expect(alpha).toHaveCount(0);
  expect(await (await checked(await request.get(`/api/projects/${id}/files/alpha.html`))).text()).toBe(HTML);

  // Design System is a real permanent tab only on an imported system project.
  const systems = await checked(await request.get('/api/design-systems'));
  const system = (await systems.json() as { designSystems: Array<{ id: string }> }).designSystems[0];
  if (!system) throw new Error('Acceptance runtime has no bundled design system');
  const design = await batch.create({ kind: 'other', importedFrom: 'design-system' }, system.id);
  await page.goto(`/projects/${design.id}/conversations/${design.conversationId}`);
  const systemTab = page.getByTestId('design-system-project-tab');
  await expect(systemTab).toBeVisible();
  await expect(systemTab.getByRole('button', { name: 'Close tab', exact: true })).toHaveCount(0);
  await systemTab.click();
  await systemTab.click({ button: 'middle' });
  await page.keyboard.press('Control+w');
  await expect(systemTab).toHaveAttribute('aria-selected', 'true');
});

for (const document of [
  { name: 'acceptance.html', type: 'text/html', content: HTML },
  { name: 'acceptance.md', type: 'text/markdown', content: '# Acceptance document\n\nMarkdown import.' },
]) {
  test(`[P1] drop-to-edit ${document.name} imports once through the daemon and opens the document`, async ({ page, request, batch }) => {
    await batch.configure();
    await page.goto('/');
    let creations = 0;
    let uploads = 0;
    page.on('request', (incoming) => {
      const path = new URL(incoming.url()).pathname;
      if (incoming.method() === 'POST' && path === '/api/projects') creations++;
      if (incoming.method() === 'POST' && /^\/api\/projects\/[^/]+\/files$/.test(path)) uploads++;
    });
    const [created, uploaded] = await Promise.all([
      page.waitForResponse((response) => isApi(response, 'POST', '/api/projects'), { timeout: T.long }),
      page.waitForResponse((response) => response.request().method() === 'POST' && /^\/api\/projects\/[^/]+\/files$/.test(new URL(response.url()).pathname), { timeout: T.long }),
      dropFiles(page.getByTestId('hub-drop-to-edit'), [document], true),
    ]);
    await checked(created);
    const project = await created.json() as CreateProjectResponse;
    batch.own(project.project.id, project.conversationId ?? undefined);
    await checked(uploaded);
    const { file } = await uploaded.json() as ProjectFileResponse;
    expect(file.name).toBe(document.name);
    expect(new URL(uploaded.url()).pathname).toBe(`/api/projects/${project.project.id}/files`);
    if (!project.conversationId) throw new Error('Imported project has no default conversation');
    const projectId = encodeURIComponent(project.project.id);
    const filePath = document.name.split('/').map(encodeURIComponent).join('/');
    const conversationId = encodeURIComponent(project.conversationId);
    await expect(page.getByRole('tab', { name: document.name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/conversations/${conversationId}/files/${filePath}`);
    // Use the viewer's raw read surface without preview bridge transformations.
    const raw = await checked(await request.get(`/api/projects/${projectId}/raw/${filePath}`, {
      params: { cacheBust: randomUUID() },
    }));
    expect(await raw.text()).toBe(document.content);
    expect(creations).toBe(1);
    expect(uploads).toBe(1);
    expect(batch.runs).toHaveLength(0);
    if (document.type === 'text/html') await expect(page.getByTestId('manual-edit-mode-toggle')).toBeVisible();
    await screenshot(page, `drop-${document.name}`);
  });
}

test('[P1] rejected drops toast, failed import rolls back without ghosts, composer drop stays separate', async ({ page, request, batch }) => {
  await batch.configure();
  await page.goto('/');
  const zone = page.getByTestId('hub-drop-to-edit');
  const doc = { name: 'rollback-document.html', type: 'text/html', content: HTML };
  let creations = 0;
  page.on('request', (incoming) => {
    if (incoming.method() === 'POST' && new URL(incoming.url()).pathname === '/api/projects') creations++;
  });
  await dropFiles(zone, [{ name: 'unsupported.exe', type: 'application/octet-stream', content: 'not executable' }]);
  await expect(page.locator('.readable-toast[role="alert"]')).toBeVisible();
  expect(creations).toBe(0);
  const firstNotice = await page.locator('.readable-toast-message').textContent();
  await dropFiles(zone, [doc, { ...doc, name: 'second.html' }]);
  await expect(page.locator('.readable-toast[role="alert"]')).toBeVisible();
  await expect(page.locator('.readable-toast-message')).not.toHaveText(firstNotice!);
  expect(creations).toBe(0);
  let importedProjectId: string | undefined;
  let uploads = 0;
  const missingProjectResponses: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 404 && importedProjectId && (
      path === `/api/projects/${importedProjectId}` || path.startsWith(`/api/projects/${importedProjectId}/`)
      || path === `/projects/${importedProjectId}` || path.startsWith(`/projects/${importedProjectId}/`)
    )) missingProjectResponses.push(path);
  });
  const createPath = (url: URL) => url.pathname === '/api/projects';
  const uploadPath = (url: URL) => url.pathname === `/api/projects/${importedProjectId}/files`;
  // Let the daemon allocate its real UUID, then arm the exact upload route
  // before the renderer receives creation and can start uploading.
  await page.route(createPath, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch();
    await checked(response);
    importedProjectId = (await response.json() as CreateProjectResponse).project.id;
    await page.route(uploadPath, async (uploadRoute) => {
      if (uploadRoute.request().method() !== 'POST') return uploadRoute.fallback();
      uploads++;
      await uploadRoute.fulfill({ status: 503, json: { error: 'Acceptance upload failure' } });
    });
    await route.fulfill({ response });
  });
  const [created, failedUpload, deleted] = await Promise.all([
    page.waitForResponse((response) => isApi(response, 'POST', '/api/projects'), { timeout: T.long }),
    page.waitForResponse((response) => isApi(response, 'POST', `/api/projects/${importedProjectId}/files`), { timeout: T.long }),
    page.waitForResponse((response) => isApi(response, 'DELETE', `/api/projects/${importedProjectId}`), { timeout: T.long }),
    dropFiles(zone, [doc]),
  ]);
  await page.unroute(createPath);
  await page.unroute(uploadPath);
  expect(failedUpload.status()).toBe(503);
  expect(uploads).toBe(1);
  await checked(created);
  const project = await created.json() as CreateProjectResponse;
  // Already rolled back: track only the id so cleanup does not read deleted runs.
  batch.own(project.project.id);
  await checked(deleted);
  await expect(zone).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.readable-toast[role="alert"]')).toBeVisible();
  expect(creations).toBe(1);
  const list = await checked(await request.get('/api/projects'));
  expect((await list.json() as { projects: Array<{ id: string }> }).projects.map(({ id }) => id)).not.toContain(project.project.id);
  await expect(page).toHaveURL(/\/$/);
  const [projectsRead] = await Promise.all([
    page.waitForResponse((response) => isApi(response, 'GET', '/api/projects'), { timeout: T.long }),
    page.goto('/projects'),
  ]);
  await checked(projectsRead);
  expect((await projectsRead.json() as { projects: Array<{ id: string }> }).projects.map(({ id }) => id)).not.toContain(project.project.id);
  // The list is allowed to be empty after rollback; its toolbar still mounts.
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(main.getByRole('group', { name: 'View mode', exact: true })).toBeVisible();
  await expect(page.getByText(project.project.name, { exact: true })).toHaveCount(0);
  await page.goto('/');
  await dropFiles(page.getByTestId('hub-composer'), [doc]);
  const stagedFiles = page.getByTestId('home-hero-staged-files');
  await expect(stagedFiles.getByText(doc.name, { exact: true })).toBeVisible();
  await expect(stagedFiles.getByRole('button', { name: `Remove ${doc.name}`, exact: true })).toHaveCount(1);
  await expect(page.getByTestId('hub-drop-to-edit')).toHaveAttribute('data-state', 'idle');
  await expect(page).toHaveURL(/\/$/);
  expect(creations).toBe(1);
  expect(uploads).toBe(1);
  expect(missingProjectResponses).toEqual([]);
  expect(batch.runs).toHaveLength(0);
});
