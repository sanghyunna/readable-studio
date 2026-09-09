import { expect, test, type Request, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, ConversationResponse, CreateProjectResponse, MessagesResponse } from '@readable-studio/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAgentRuntimes, HELD_QUESTION_RUN } from '@/fake-agents';
import { cleanupHydrationRuns, gateQuestionHydration, seedHydrationQuestion } from '@/playwright/question-hydration';
import { observeProjectFileHydration } from '@/playwright/project-file-hydration';
import { T } from '@/timeouts';
import { addStorageInitScript } from '@/playwright/storage-init';

interface QueuedSend {
  id: string;
  conversationId: string;
  prompt: string;
  attachments: unknown[];
  commentAttachments: unknown[];
  createdAt: number;
  meta: { sessionMode: string };
}

// Real daemon and fake Codex process; only hydration responses are held/failed.
// No timer controls the agent or establishes that a network request completed.
for (const outcome of ['idle', 'active'] as const) {
  test(`[P1] Questions ${outcome} hydration retries once per click burst and preserves answers and queue`, async ({ page, request }, testInfo) => {
    test.setTimeout(T.xlong * 2);
    const root = await mkdtemp(join(tmpdir(), 'readable-question-hydration-'));
    let projectId: string | undefined;
    let conversationId: string | undefined;
    let savedConfig: Record<string, unknown> | undefined;
    let gate: Awaited<ReturnType<typeof gateQuestionHydration>> | undefined;
    const runRequests: ChatRequest[] = [];
    let messageReads = 0;
    const observe = (incoming: Request) => {
      const url = new URL(incoming.url());
      if (incoming.method() === 'POST' && url.pathname === '/api/runs') {
        const body = incoming.postDataJSON() as ChatRequest;
        if (body.projectId === projectId) runRequests.push(body);
      }
      if (incoming.method() === 'GET'
        && url.pathname === `/api/projects/${projectId}/conversations/${conversationId}/messages`) messageReads++;
    };
    page.on('request', observe);
    const fileHydration = observeProjectFileHydration(page);
    try {
      const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
      const configResponse = await request.get('/api/app-config');
      expect(configResponse.ok(), await configResponse.text()).toBe(true);
      savedConfig = ((await configResponse.json()) as { config: Record<string, unknown> }).config;
      const config = {
        ...savedConfig, mode: 'daemon', agentId: 'codex', skillId: null, designSystemId: null,
        onboardingCompleted: true, privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
        agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } },
        agentCliEnv: { codex: codex.env },
      };
      const configured = await request.put('/api/app-config', { data: config });
      expect(configured.ok(), await configured.text()).toBe(true);
      await addStorageInitScript(page, (initialConfig) => {
        localStorage.setItem('readable-studio:config', JSON.stringify(initialConfig));
        localStorage.setItem('readable-studio:locale', 'en');
        localStorage.setItem('readable-studio:locale-source', 'manual');
      }, config);
      const created = await request.post('/api/projects', { data: {
        id: randomUUID(), name: 'Question hydration recovery', skillId: null, designSystemId: null,
        conversationMode: 'design', metadata: { kind: 'prototype' },
      } });
      expect(created.ok(), await created.text()).toBe(true);
      const project = await created.json() as CreateProjectResponse;
      projectId = project.project.id;
      conversationId = project.conversationId;
      if (!conversationId) throw new Error('Created project has no default conversation');
      const messagePath = `/api/projects/${projectId}/conversations/${conversationId}/messages`;
      const url = `/projects/${projectId}/conversations/${conversationId}`;
      const queueKey = `readable:chat-queued-sends:${projectId}:v1`;
      const readQueue = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as QueuedSend[], queueKey);
      const readQueueBytes = () => page.evaluate((key) => localStorage.getItem(key), queueKey);
      const readDrafts = () => page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith('readable-studio:question-form-draft:'))));
      const isRunPost = (response: Response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/runs'
        && (response.request().postDataJSON() as ChatRequest).projectId === projectId;
      const isMessageSave = (response: Response, predicate: (message: ChatMessage) => boolean) =>
        response.request().method() === 'PUT' && new URL(response.url()).pathname.startsWith(`${messagePath}/`)
        && predicate(response.request().postDataJSON() as ChatMessage);
      let heldRunId: string | undefined;
      if (outcome === 'active') {
        await page.goto(url);
        await page.getByTestId('chat-composer-input').fill(HELD_QUESTION_RUN.prompt);
        const [started, formSaved] = await Promise.all([
          page.waitForResponse(isRunPost, { timeout: T.long }),
          page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'assistant'
            && message.content.includes(`id="${HELD_QUESTION_RUN.formId}"`)), { timeout: T.long }),
          page.getByTestId('chat-send').click(),
        ]);
        for (const response of [started, formSaved]) expect(response.ok(), await response.text()).toBe(true);
        heldRunId = ((await started.json()) as { runId: string }).runId;
        await page.getByTestId('chat-composer-input').fill('Keep this queued draft during hydration');
        await page.getByTestId('chat-composer-input').press('Enter');
        await expect(page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row')).toHaveCount(1);
      } else {
        await seedHydrationQuestion(request, projectId, conversationId);
        // A real, different conversation gives idle hydration a nonempty queue
        // to preserve without immediately auto-promoting a current-conversation send.
        const other = await request.post(`/api/projects/${projectId}/conversations`, { data: { title: 'Queued elsewhere' } });
        expect(other.ok(), await other.text()).toBe(true);
        const otherConversation = (await other.json() as ConversationResponse).conversation;
        const queued: QueuedSend = {
          id: randomUUID(), conversationId: otherConversation.id, prompt: 'Preserve this other conversation queue',
          attachments: [], commentAttachments: [], createdAt: Date.now(), meta: { sessionMode: 'design' },
        };
        await addStorageInitScript(page, ({ key, value }) => {
          if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify([value]));
        }, { key: queueKey, value: queued });
      }

      gate = await gateQuestionHydration(page, projectId, conversationId);
      // Account for outgoing-document reads created by SSE teardown itself.
      // Idle has no mounted project (and hence no pre-navigation reads).
      const initial = await gate.next(() => outcome === 'active'
        ? fileHydration.navigate(() => page.goto(url, { timeout: T.long }), T.long, 'no-artifact')
        : page.goto(url, { timeout: T.long }));
      await page.getByRole('tab', { name: /^Questions/ }).click();
      const panel = page.getByTestId('questions-panel');
      const form = panel.locator(`[data-form-id="${HELD_QUESTION_RUN.formId}"]`);
      const continueButton = panel.locator('.questions-continue');
      const skipButton = panel.locator('.questions-skip');
      const retry = panel.getByRole('button', { name: 'Retry run check', exact: true });
      const target = form.getByRole('radio', { name: 'Desktop web', exact: true });
      const audience = form.getByRole('textbox', { name: 'Audience details', exact: true });
      await expect(form).toBeVisible();
      await expect(continueButton).toBeDisabled();
      await expect(skipButton).toBeDisabled();
      await expect(panel.getByRole('status')).not.toBeEmpty();
      await target.click();
      let answer = 'Design reviewers\nKeep this second line.';
      await audience.fill(answer);
      const queueBytes = await readQueueBytes();
      const originalQueue = await readQueue();
      expect(originalQueue).toHaveLength(1);
      const postsBeforeRecovery = runRequests.length;
      const readsBeforeRetry = messageReads;
      const assertPreserved = async () => {
        await expect(target).toHaveAttribute('aria-checked', 'true');
        await expect(audience).toHaveValue(answer);
        await expect(audience).toBeEditable();
        await expect(form).not.toHaveClass(/question-form-locked/);
        expect(await readQueueBytes()).toBe(queueBytes);
        expect(runRequests).toHaveLength(postsBeforeRecovery);
        expect(messageReads).toBe(readsBeforeRetry);
      };
      const initialDrafts = await readDrafts();
      expect(Object.values(initialDrafts).map((value) => JSON.parse(value) as unknown))
        .toContainEqual({ target: 'desktop-web', audience: answer });
      await initial.fail();
      await expect(retry).toBeVisible();
      await expect(continueButton).toBeDisabled();
      await assertPreserved();
      expect(await readDrafts()).toEqual(initialDrafts);

      // Two independent bursts: failed retry must expose retry again; successful
      // retry must use the daemon's actual answer, not a fabricated empty list.
      for (const recovery of ['failure', 'success'] as const) {
        const held = await gate.next(() => retry.evaluate((button) => {
          // Same browser task, no Playwright actionability wait between clicks.
          // Retaining the element also stresses stale clicks after it is removed.
          for (let click = 0; click < 20; click++) (button as HTMLButtonElement).click();
        }));
        await expect(retry).toHaveCount(0);
        await expect(continueButton).toBeDisabled();
        await expect(skipButton).toBeDisabled();
        await assertPreserved();
        expect(gate.requestCount).toBe(recovery === 'failure' ? 2 : 3);
        expect(gate.inflight).toBe(1);
        expect(gate.maxInflight).toBe(1);
        answer += `\nEdited during ${recovery} retry.`;
        await audience.fill(answer);
        const drafts = await readDrafts();
        if (recovery === 'failure') {
          await held.fail();
          await expect(retry).toBeVisible();
          await expect(continueButton).toBeDisabled();
          await assertPreserved();
        } else {
          const authoritative = await held.succeed();
          expect(authoritative.runs.map(({ id, status }) => ({ id, status })))
            .toEqual(outcome === 'idle' ? [] : [{ id: heldRunId, status: 'running' }]);
          await expect(continueButton).toBeEnabled();
          await expect(skipButton).toBeEnabled();
          await expect(retry).toHaveCount(0);
          await assertPreserved();
        }
        expect(await readDrafts()).toEqual(drafts);
      }

      if (outcome === 'active') {
        await continueButton.click();
        await expect(page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row')).toHaveCount(2);
        const finalQueue = await readQueue();
        expect(finalQueue[0]).toEqual(originalQueue[0]);
        expect(finalQueue[1]).toMatchObject({ conversationId, prompt: expect.stringContaining(answer) });
        expect(runRequests).toHaveLength(postsBeforeRecovery);
        // The held run has emitted only a question, not an artifact. Its final
        // user-visible result is the preserved form plus two queued sends.
        await expect(page.getByTestId('artifact-preview-frame')).toHaveCount(0);
        await expect(audience).toHaveValue(answer);
      } else {
        const [started, saved] = await Promise.all([
          page.waitForResponse(isRunPost, { timeout: T.long }),
          page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'assistant'
            && message.runStatus === 'succeeded'), { timeout: T.long }),
          continueButton.click(),
        ]);
        for (const response of [started, saved]) expect(response.ok(), await response.text()).toBe(true);
        const artifact = page.frameLocator('[data-testid="artifact-preview-frame"]');
        await expect(artifact.getByRole('heading', { name: 'Fake Agent Runtime codex' })).toBeVisible();
        await expect(artifact.getByText('Generated through fake codex runtime.', { exact: true })).toBeVisible();
        expect(runRequests).toHaveLength(1);
        expect(runRequests[0]).toMatchObject({ projectId, conversationId, currentPrompt: expect.stringContaining(answer) });
        expect(await readQueue()).toEqual(originalQueue);
        const messages = await request.get(messagePath);
        expect(messages.ok(), await messages.text()).toBe(true);
        expect((await messages.json() as MessagesResponse).messages.filter((message) => message.role === 'user'))
          .toHaveLength(1);
      }
      // The final public transition is the barrier, not an arbitrary quiet period.
      expect(gate.requestCount).toBe(3);
      expect(gate.maxInflight).toBe(1);
      expect(gate.inflight).toBe(0);
    } finally {
      page.off('request', observe);
      try {
        await gate?.dispose();
      } finally {
        try {
          try {
            await fileHydration.drain(T.long, outcome === 'active' ? 'no-artifact' : 'raw');
          } finally {
            // Always unmount, including when the validation above fails.
            fileHydration.dispose();
            await page.close();
            if (projectId && conversationId) {
              await cleanupHydrationRuns(request, projectId, conversationId, outcome === 'active');
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
              fileHydration.dispose();
              await testInfo.attach('project-file-hydration-counts', {
                contentType: 'application/json', body: JSON.stringify({ ...fileHydration.counts, requests: fileHydration.requests }),
              });
              await rm(root, { recursive: true, force: true });
            }
          }
        }
      }
    }
  });
}
