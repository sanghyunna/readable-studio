import { expect, test, type APIRequestContext, type Request, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, ChatRunListResponse, CreateProjectResponse, MessagesResponse } from '@readable-studio/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAgentRuntimes, HELD_QUESTION_RUN } from '@/fake-agents';
import { T } from '@/timeouts';

interface QueuedAnswer {
  id: string;
  conversationId: string;
  prompt: string;
  attachments: unknown[];
  commentAttachments: unknown[];
  createdAt: number;
  meta: { sessionMode: string };
}

// Real daemon + generated Codex CLI. No run/message routes are intercepted.
// Completion is synchronized with successful message PUT responses, not sleeps
// or repeated status requests. The file signal is sent only after reload proof.
test('[P1] required questions queue during a held run, survive reload, and promote once', async ({ page, request }) => {
  test.setTimeout(T.xlong * 2);
  const root = await mkdtemp(join(tmpdir(), 'readable-held-question-'));
  let projectId: string | undefined;
  let savedConfig: Record<string, unknown> | undefined;
  let conversationId: string | undefined;
  const runRequests: ChatRequest[] = [];
  const observeRun = (incoming: Request) => {
    if (incoming.method() !== 'POST' || new URL(incoming.url()).pathname !== '/api/runs') return;
    const body = incoming.postDataJSON() as ChatRequest;
    if (body.projectId === projectId) runRequests.push(body);
  };
  page.on('request', observeRun);

  try {
    const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
    const configResponse = await request.get('/api/app-config');
    expect(configResponse.ok(), await configResponse.text()).toBe(true);
    savedConfig = ((await configResponse.json()) as { config: Record<string, unknown> }).config;
    const config = {
      ...savedConfig,
      mode: 'daemon', agentId: 'codex', skillId: null, designSystemId: null,
      onboardingCompleted: true, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
      agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } },
      agentCliEnv: { codex: codex.env },
    };
    const configured = await request.put('/api/app-config', { data: config });
    expect(configured.ok(), await configured.text()).toBe(true);
    await page.addInitScript((initialConfig) => {
      localStorage.setItem('readable-studio:config', JSON.stringify(initialConfig));
      localStorage.setItem('readable-studio:locale', 'en');
      localStorage.setItem('readable-studio:locale-source', 'manual');
    }, config);

    const created = await request.post('/api/projects', { data: {
      id: randomUUID(), name: 'Held question queue', skillId: null, designSystemId: null,
      conversationMode: 'design', metadata: { kind: 'prototype' },
    } });
    expect(created.ok(), await created.text()).toBe(true);
    const project = (await created.json()) as CreateProjectResponse;
    projectId = project.project.id;
    conversationId = project.conversationId;
    if (!conversationId) throw new Error('Created project has no default conversation');
    const messagePath = `/api/projects/${projectId}/conversations/${conversationId}/messages`;
    const queueKey = `readable:chat-queued-sends:${projectId}:v1`;
    const readQueue = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as QueuedAnswer[], queueKey);
    const messages = async () => {
      const response = await request.get(messagePath);
      expect(response.ok(), await response.text()).toBe(true);
      return ((await response.json()) as MessagesResponse).messages;
    };
    const runs = () => listRuns(request, projectId!, conversationId!);
    const isMessageSave = (response: Response, predicate: (message: ChatMessage) => boolean) =>
      response.request().method() === 'PUT'
      && new URL(response.url()).pathname.startsWith(`${messagePath}/`)
      && predicate(response.request().postDataJSON() as ChatMessage);

    await page.goto(`/projects/${projectId}/conversations/${conversationId}`);
    await page.getByTestId('chat-composer-input').fill(HELD_QUESTION_RUN.prompt);
    const [started, formSaved] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/runs', { timeout: T.long }),
      page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'assistant'
        && message.content.includes(`id="${HELD_QUESTION_RUN.formId}"`)), { timeout: T.long }),
      page.getByTestId('chat-send').click(),
    ]);
    expect(started.ok(), await started.text()).toBe(true);
    expect(formSaved.ok(), await formSaved.text()).toBe(true);
    const { runId: heldRunId } = (await started.json()) as { runId: string };
    const assertHeldOnly = async () => {
      expect((await runs()).map(({ id, status }) => ({ id, status }))).toEqual([{ id: heldRunId, status: 'running' }]);
      expect(runRequests).toHaveLength(1);
    };

    const panel = page.getByTestId('questions-panel');
    const form = panel.locator(`[data-form-id="${HELD_QUESTION_RUN.formId}"]`);
    const continueButton = panel.locator('.questions-continue');
    const target = form.getByRole('radio', { name: 'Desktop web', exact: true });
    const audience = form.getByRole('textbox', { name: 'Audience details', exact: true });
    const audienceAnswer = 'Design reviewers, including QA\nPreserve this second line.';
    await expect(form).toBeVisible({ timeout: T.long });
    await expect(continueButton).toBeDisabled();
    await assertHeldOnly();
    await target.click();
    await expect(target).toHaveAttribute('aria-checked', 'true');
    await expect(continueButton).toBeDisabled();
    await audience.fill('   ');
    await expect(continueButton).toBeDisabled();
    await audience.fill(audienceAnswer);
    await expect(continueButton).toBeEnabled();
    await assertHeldOnly();

    await continueButton.click();
    await expect(form).toHaveClass(/question-form-locked/);
    await expect(continueButton).toBeDisabled();
    await expect(page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row')).toHaveCount(1);
    const queued = await readQueue();
    expect(queued).toHaveLength(1);
    const answer = queued[0]!;
    expect(answer).toEqual({
      id: expect.any(String), conversationId,
      prompt: `[form answers \u2014 ${HELD_QUESTION_RUN.formId}]\n- Delivery target: Desktop web [value: desktop-web]\n- Audience details: ${audienceAnswer}`,
      attachments: [], commentAttachments: [], createdAt: expect.any(Number),
      meta: { sessionMode: 'design' },
    });
    expect(answer.id.length).toBeGreaterThan(0);
    await assertHeldOnly();
    expect((await messages()).filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual([HELD_QUESTION_RUN.prompt]);

    // A visible queue alone can precede hydration. Observe the original run's
    // reattachment before proving it remains pending and releasing the agent.
    await Promise.all([
      page.waitForRequest((incoming) => incoming.method() === 'GET'
        && new URL(incoming.url()).pathname === `/api/runs/${heldRunId}/events`, { timeout: T.long }),
      page.reload({ waitUntil: 'domcontentloaded' }),
    ]);
    await expect(page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row')).toHaveCount(1);
    // Reopen through the public Questions tab if reload restored another tab.
    await page.getByRole('tab', { name: /^Questions/ }).click();
    await expect(form).toBeVisible();
    await expect(form).toHaveClass(/question-form-locked/);
    await expect(target).toHaveAttribute('aria-checked', 'true');
    await expect(target).toBeDisabled();
    await expect(audience).toHaveValue(audienceAnswer);
    await expect(audience).toBeDisabled();
    await expect(continueButton).toBeDisabled();
    expect(await readQueue()).toEqual(queued);
    await assertHeldOnly();
    expect((await messages()).filter((message) => message.role === 'user')).toHaveLength(1);

    // Subscribe to each exact transition before writing the release signal.
    // The held assistant's terminal PUT also proves reload reattached its SSE.
    const [heldSaved, promoted, answerSaved, promotedSaved, released] = await Promise.all([
      page.waitForResponse((response) => isMessageSave(response, (message) => message.runId === heldRunId
        && message.runStatus === 'succeeded'), { timeout: T.long }),
      page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/runs'
        && (response.request().postDataJSON() as ChatRequest).currentPrompt === answer.prompt, { timeout: T.long }),
      page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'user'
        && message.content === answer.prompt), { timeout: T.long }),
      page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'assistant'
        && message.runId !== heldRunId && message.runStatus === 'succeeded'), { timeout: T.long }),
      request.post(`/api/projects/${projectId}/files`, { data: {
        name: HELD_QUESTION_RUN.releaseFile, content: HELD_QUESTION_RUN.releaseToken,
      } }),
    ]);
    for (const response of [heldSaved, promoted, answerSaved, promotedSaved, released]) {
      expect(response.ok(), await response.text()).toBe(true);
    }
    const { runId: promotedRunId } = (await promoted.json()) as { runId: string };
    expect(promotedRunId).not.toBe(heldRunId);
    const promotion = promoted.request().postDataJSON() as ChatRequest;
    expect(promotion).toMatchObject({
      projectId, conversationId, currentPrompt: answer.prompt,
      sessionMode: answer.meta.sessionMode, attachments: [], commentAttachments: [], agentId: 'codex',
    });
    expect(promotion.message).toContain(answer.prompt);
    await expect(page.getByTestId('chat-queued-send-strip')).toHaveCount(0);
    expect(await readQueue()).toEqual([]);
    expect(runRequests).toHaveLength(2);
    expect((await runs()).map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([heldRunId, promotedRunId].sort().map((id) => ({ id, status: 'succeeded' })));
    const finalMessages = await messages();
    expect(finalMessages.filter((message) => message.role === 'user').map((message) => ({ content: message.content, sessionMode: message.sessionMode })))
      .toEqual([{ content: HELD_QUESTION_RUN.prompt, sessionMode: 'design' }, { content: answer.prompt, sessionMode: 'design' }]);
    expect(finalMessages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(finalMessages.filter((message) => message.runId === heldRunId)[0]?.content)
      .toContain(`id="${HELD_QUESTION_RUN.formId}"`);
  } finally {
    page.off('request', observeRun);
    // Unmount first so cancellation cannot auto-promote a pending answer.
    // Delete the isolated project (including the signal) even on assertion failure.
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
