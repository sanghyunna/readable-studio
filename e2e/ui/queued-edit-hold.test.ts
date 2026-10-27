import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Request, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, ChatRunListResponse, MessagesResponse } from '@readable-studio/contracts';
import { createQueuedEditAgent, QUEUED_EDIT_RUN } from '@/playwright/queued-edit-agent';
import { addStorageInitScript } from '@/playwright/storage-init';
import { T } from '@/timeouts';

const ORIGINAL = `${QUEUED_EDIT_RUN.queuedMarker}A original`;
const CONFIRMED = `${QUEUED_EDIT_RUN.queuedMarker}A confirmed`;
const SECOND = `${QUEUED_EDIT_RUN.queuedMarker}B`;
const selection = { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } } };

// Real daemon + generated Codex app-server CLI; no product route is intercepted.
// Transitions are synchronized with run/message responses, not sleeps.
test('[P0] a queued send being edited holds its turn, then runs once with the confirmed text in FIFO order', async ({ page, request }, testInfo) => {
  test.setTimeout(T.xlong * 2);
  const root = await mkdtemp(join(tmpdir(), 'readable-queued-edit-'));
  let savedConfig: Record<string, unknown> | undefined;
  let projectId: string | undefined;
  let conversationId: string | undefined;
  const runPrompts: (string | undefined)[] = [];
  const observeRun = (incoming: Request) => {
    if (incoming.method() !== 'POST' || new URL(incoming.url()).pathname !== '/api/runs') return;
    const body = incoming.postDataJSON() as ChatRequest;
    if (body.projectId === projectId) runPrompts.push(body.currentPrompt);
  };
  page.on('request', observeRun);

  try {
    const codex = await createQueuedEditAgent(root);
    const original = await request.get('/api/app-config');
    expect(original.ok(), await original.text()).toBe(true);
    savedConfig = ((await original.json()) as { config: Record<string, unknown> }).config;
    const config = { ...savedConfig, ...selection, enabledAgentIds: ['codex'], skillId: null, designSystemId: null,
      onboardingCompleted: true, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false }, agentCliEnv: { codex: codex.env } };
    const configured = await request.put('/api/app-config', { data: config });
    expect(configured.ok(), await configured.text()).toBe(true);
    await addStorageInitScript(page, (value) => {
      localStorage.setItem('readable-studio:config', JSON.stringify(value));
      localStorage.setItem('readable-studio:locale', 'en');
      localStorage.setItem('readable-studio:locale-source', 'manual');
      localStorage.setItem('readable-studio:welcome-modal-shown', '1');
    }, config);

    projectId = randomUUID();
    const created = await request.post('/api/projects', { data: {
      id: projectId, name: 'Queued edit hold', skillId: null, designSystemId: null, metadata: { kind: 'prototype' },
    } });
    expect(created.ok(), await created.text()).toBe(true);
    conversationId = ((await created.json()) as { conversationId: string }).conversationId;
    const selected = await request.patch(`/api/projects/${projectId}/conversations/${conversationId}`, { data: { selection } });
    expect(selected.ok(), await selected.text()).toBe(true);

    const messagePath = `/api/projects/${projectId}/conversations/${conversationId}/messages`;
    const queueKey = `readable:chat-queued-sends:${projectId}:v1`;
    const readQueue = () => page.evaluate((key) =>
      (JSON.parse(localStorage.getItem(key) ?? '[]') as { prompt: string }[]).map((item) => item.prompt), queueKey);
    const userTurns = async () => {
      const response = await request.get(messagePath);
      expect(response.ok(), await response.text()).toBe(true);
      return ((await response.json()) as MessagesResponse).messages
        .filter((message) => message.role === 'user').map((message) => message.content);
    };
    const runs = () => listRuns(request, projectId!, conversationId!);
    const isMessageSave = (response: Response, predicate: (message: ChatMessage) => boolean) =>
      response.request().method() === 'PUT'
      && new URL(response.url()).pathname.startsWith(`${messagePath}/`)
      && predicate(response.request().postDataJSON() as ChatMessage);
    const runStarted = (prompt: string) => page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/runs'
      && (response.request().postDataJSON() as ChatRequest).currentPrompt === prompt, { timeout: T.long });
    const userSaved = (prompt: string) => page.waitForResponse((response) =>
      isMessageSave(response, (message) => message.role === 'user' && message.content === prompt), { timeout: T.long });
    const runIdOf = async (response: Response) => {
      expect(response.status(), await response.text()).toBe(202);
      return ((await response.json()) as { runId: string }).runId;
    };

    await page.goto(`/projects/${projectId}/conversations/${conversationId}`);
    const composer = page.getByTestId('chat-composer-input');
    const send = page.getByTestId('chat-send');
    await composer.fill(QUEUED_EDIT_RUN.heldPrompt);
    const [heldStart] = await Promise.all([runStarted(QUEUED_EDIT_RUN.heldPrompt), send.click()]);
    const heldRunId = await runIdOf(heldStart);
    await expect(page.getByText(QUEUED_EDIT_RUN.heldAck)).toBeVisible({ timeout: T.long });

    // Queue A then B through the composer while the held run is busy.
    const rows = page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row');
    await composer.fill(ORIGINAL);
    await send.click();
    await expect(rows).toHaveCount(1);
    await composer.fill(SECOND);
    await send.click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(ORIGINAL);
    await expect(rows.nth(1)).toContainText(SECOND);
    expect(await readQueue()).toEqual([ORIGINAL, SECOND]);

    // Open A for editing and change the draft without confirming it.
    const rowA = rows.nth(0);
    await rowA.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(composer).toHaveText(ORIGINAL);
    await expect(rowA).toHaveClass(/chat-queued-send-row-editing/);
    await expect(rowA.getByText('Sends once you finish editing', { exact: true })).toBeVisible();
    await expect(rowA.getByTestId('chat-queued-send-now')).toBeDisabled();
    await composer.fill(CONFIRMED);
    await expect(composer).toHaveText(CONFIRMED);
    expect(await readQueue()).toEqual([ORIGINAL, SECOND]);
    expect(runPrompts).toEqual([QUEUED_EDIT_RUN.heldPrompt]);

    // Release the held run: A's turn comes, but A is mid-edit, so nothing runs.
    const [heldSaved] = await Promise.all([
      page.waitForResponse((response) => isMessageSave(response, (message) => message.runId === heldRunId
        && message.runStatus === 'succeeded'), { timeout: T.long }),
      (async () => {
        const released = await request.post(`/api/projects/${projectId}/files`, { data: {
          name: QUEUED_EDIT_RUN.releaseFile, content: QUEUED_EDIT_RUN.releaseToken,
        } });
        expect(released.ok(), await released.text()).toBe(true);
      })(),
    ]);
    expect(heldSaved.ok(), await heldSaved.text()).toBe(true);
    await expect(page.locator('.assistant-footer[data-streaming="true"]')).toHaveCount(0);
    await expect(page.locator('.assistant-footer[data-last="true"]')).toContainText('Done');
    await expect(rows).toHaveCount(2);
    await expect(rowA).toHaveClass(/chat-queued-send-row-editing/);
    await expect(rowA).toContainText(ORIGINAL);
    await expect(rowA.getByText('Sends once you finish editing', { exact: true })).toBeVisible();
    await expect(composer).toHaveText(CONFIRMED);
    expect(await readQueue()).toEqual([ORIGINAL, SECOND]);
    expect(runPrompts).toEqual([QUEUED_EDIT_RUN.heldPrompt]);
    expect(await userTurns()).toEqual([QUEUED_EDIT_RUN.heldPrompt]);
    expect((await runs()).map(({ id, status }) => ({ id, status }))).toEqual([{ id: heldRunId, status: 'succeeded' }]);

    // Confirm the edit: A runs once with the confirmed text, then B follows.
    const [aStart, bStart, aUser, bUser] = await Promise.all([
      runStarted(CONFIRMED), runStarted(SECOND), userSaved(CONFIRMED), userSaved(SECOND), send.click(),
    ]);
    for (const response of [aUser, bUser]) expect(response.ok(), await response.text()).toBe(true);
    const runIds = [heldRunId, await runIdOf(aStart), await runIdOf(bStart)];
    for (const runId of runIds.slice(1)) {
      // The SSE replay ends only once the run is terminal.
      const terminal = await request.get(`/api/runs/${runId}/events`, { timeout: T.long });
      expect(terminal.ok(), await terminal.text()).toBe(true);
    }
    await expect(page.getByTestId('chat-queued-send-strip')).toHaveCount(0);
    await expect(composer).toHaveText('');
    expect(await readQueue()).toEqual([]);
    expect(runPrompts).toEqual([QUEUED_EDIT_RUN.heldPrompt, CONFIRMED, SECOND]);
    expect(await userTurns()).toEqual([QUEUED_EDIT_RUN.heldPrompt, CONFIRMED, SECOND]);
    expect((await runs()).map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...runIds].sort().map((id) => ({ id, status: 'succeeded' })));
    await testInfo.attach('queued-edit-hold', { body: JSON.stringify({ runIds, runPrompts }), contentType: 'application/json' });
  } finally {
    page.off('request', observeRun);
    // Unmount first so cleanup cannot auto-start a pending queued send.
    try {
      await page.goto('about:blank');
      if (projectId && conversationId) {
        for (const run of await listRuns(request, projectId, conversationId)) {
          if (run.status !== 'queued' && run.status !== 'running') continue;
          const canceled = await request.post(`/api/runs/${run.id}/cancel`);
          expect(canceled.ok(), await canceled.text()).toBe(true);
          const terminal = await request.get(`/api/runs/${run.id}/events`, { timeout: T.long });
          expect(terminal.ok(), await terminal.text()).toBe(true);
        }
      }
    } finally {
      try {
        if (projectId) {
          const deleted = await request.delete(`/api/projects/${projectId}`);
          expect(deleted.ok(), await deleted.text()).toBe(true);
        }
      } finally {
        try {
          if (savedConfig) {
            const restored = await request.put('/api/app-config', { data: savedConfig });
            expect(restored.ok(), await restored.text()).toBe(true);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
});

async function listRuns(request: APIRequestContext, projectId: string, conversationId: string) {
  const response = await request.get('/api/runs', { params: { projectId, conversationId } });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as ChatRunListResponse).runs;
}
