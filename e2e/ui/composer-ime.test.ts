import { expect, test, type Request, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, ChatRunListResponse, CreateProjectResponse, MessagesResponse } from '@readable-studio/contracts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAgentRuntimes, HELD_QUESTION_RUN } from '@/fake-agents';
import { observeComposerIme } from '@/playwright/composer-ime';
import { observeProjectFileHydration } from '@/playwright/project-file-hydration';
import { cleanupHydrationRuns } from '@/playwright/question-hydration';
import { T } from '@/timeouts';
import { addStorageInitScript } from '@/playwright/storage-init';

// Browser contract for the intentional #2851 skip in
// apps/web/tests/components/composer/LexicalComposerInput.test.tsx:
// jsdom cannot drive Lexical's compositionstart/beforeinput/compositionend
// pipeline. Leave that skip in place; exercise native Chromium editing here.
// CDP drives browser-owned composition events/DOM edits, not a physical Windows
// Korean IME. Some Chromium builds expose their scoped compositionend as
// isTrusted=false; record that capability without skipping editor/send coverage.
// Run/message APIs are real; the fake Codex agent stays held until file release.
test('[P1] Korean IME commits once without sending, then Enter sends once while idle or queues once while busy', async ({ page, request, browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(T.xlong * 2);
  const root = await mkdtemp(join(tmpdir(), 'readable-composer-ime-'));
  let projectId: string | undefined;
  let conversationId: string | undefined;
  let savedConfig: Record<string, unknown> | undefined;
  const runRequests: ChatRequest[] = [];
  const observeRun = (incoming: Request) => {
    if (incoming.method() !== 'POST' || new URL(incoming.url()).pathname !== '/api/runs') return;
    const body = incoming.postDataJSON() as ChatRequest;
    if (body.projectId === projectId) runRequests.push(body);
  };
  page.on('request', observeRun);
  const fileHydration = observeProjectFileHydration(page);
  const runs = async () => {
    const response = await request.get('/api/runs', { params: { projectId: projectId!, conversationId: conversationId! } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as ChatRunListResponse).runs;
  };

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
      id: randomUUID(), name: 'Composer IME lifecycle', skillId: null, designSystemId: null,
      conversationMode: 'design', metadata: { kind: 'prototype' },
    } });
    expect(created.ok(), await created.text()).toBe(true);
    const project = (await created.json()) as CreateProjectResponse;
    projectId = project.project.id;
    conversationId = project.conversationId;
    if (!conversationId) throw new Error('Created project has no default conversation');
    const messagePath = `/api/projects/${projectId}/conversations/${conversationId}/messages`;
    const queueKey = `readable:chat-queued-sends:${projectId}:v1`;
    const readQueue = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{
      id: string; conversationId: string; prompt: string;
    }>, queueKey);
    const messages = async () => {
      const response = await request.get(messagePath);
      expect(response.ok(), await response.text()).toBe(true);
      return ((await response.json()) as MessagesResponse).messages;
    };
    const isMessageSave = (response: Response, predicate: (message: ChatMessage) => boolean) =>
      response.request().method() === 'PUT'
      && new URL(response.url()).pathname.startsWith(`${messagePath}/`)
      && predicate(response.request().postDataJSON() as ChatMessage);
    const isRunStart = (response: Response, prompt: string) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/runs'
      && (response.request().postDataJSON() as ChatRequest).currentPrompt === prompt;

    await page.goto(`/projects/${projectId}/conversations/${conversationId}`);
    const input = page.getByTestId('chat-composer-input');
    const idlePrefix = `${HELD_QUESTION_RUN.prompt} `;
    const queuedPrefix = 'Follow up: ';
    // Korean 2-beolsik syllable progression: hieuh -> ha -> han. Keep the
    // pre-existing prefix so replacing, dropping or duplicating it also fails.
    const candidates = ['\u314e', '\ud558', '\ud55c'];
    const syllable = candidates[2]!;
    const idlePrompt = `${idlePrefix}${syllable}`;
    const queuedPrompt = `${queuedPrefix}${syllable}`;
    let heldRunId: string | undefined;
    let trustedCompositionEnd: boolean | undefined;

    for (const [index, prefix] of [idlePrefix, queuedPrefix].entries()) {
      await input.fill(prefix);
      await input.press('End');
      await expect(page.getByTestId('chat-send')).toBeEnabled();
      const ime = await observeComposerIme(page, input);
      const assertUnsent = async () => {
        expect(runRequests).toHaveLength(index);
        expect(await readQueue()).toEqual([]);
        expect((await messages()).filter((message) => message.role === 'user').map((message) => message.content))
          .toEqual(index === 0 ? [] : [idlePrompt]);
        expect((await runs()).map(({ id, status }) => ({ id, status })))
          .toEqual(index === 0 ? [] : [{ id: heldRunId, status: 'running' }]);
      };
      try {
        expect((await ime.snapshot()).composing).toBe(false);
        for (const candidate of candidates) {
          await ime.update(candidate);
          const state = await ime.snapshot();
          expect(state.composing).toBe(true);
          expect(state.text).toBe(`${prefix}${candidate}`);
        }
        await ime.composingEnter();
        const confirming = await ime.snapshot();
        expect(confirming.composing).toBe(true);
        expect(confirming.text).toBe(`${prefix}${syllable}`);
        expect(confirming.events.filter((event) => event.type === 'keydown')).toEqual([
          expect.objectContaining({ key: 'Enter', isComposing: true, isTrusted: true }),
        ]);
        await assertUnsent();

        await ime.commit(syllable);
        const committed = await ime.snapshot();
        expect(committed.composing).toBe(false);
        expect(committed.text).toBe(`${prefix}${syllable}`);
        expect(committed.domText).toBe(`${prefix}${syllable}`);
        // Only scoped compositionend may lack trust. An untrusted start,
        // update, input, or key event is still a harness failure, not a fallback.
        expect(committed.events.filter((event) => event.type !== 'compositionend')
          .every((event) => event.isTrusted)).toBe(true);
        expect(committed.trustedCompositionEnd, 'Exactly one browser compositionend must be observed').not.toBeNull();
        if (index === 0) {
          trustedCompositionEnd = committed.trustedCompositionEnd!;
          testInfo.annotations.push({
            type: trustedCompositionEnd ? 'ime-trust-capability' : 'ime-trust-limitation',
            description: `CDP compositionend.isTrusted=${trustedCompositionEnd}; browser-owned editing, not physical Windows IME coverage.`,
          });
        }
        expect(committed.trustedCompositionEnd, 'Idle and busy compositions must expose the same trust capability')
          .toBe(trustedCompositionEnd);
        const lifecycle = committed.events.filter((event) => !event.type.startsWith('key'));
        expect(lifecycle[0]).toMatchObject({ type: 'compositionstart' });
        // Each replacement must traverse both native input events, in order.
        expect(lifecycle.slice(1, 1 + candidates.length * 3)).toEqual(
          candidates.flatMap((data) => [
            expect.objectContaining({ type: 'compositionupdate', data }),
            expect.objectContaining({ type: 'beforeinput', data, inputType: 'insertCompositionText', isComposing: true }),
            expect.objectContaining({ type: 'input', data, inputType: 'insertCompositionText', isComposing: true }),
          ]),
        );
        expect(lifecycle.filter((event) => event.type === 'compositionstart')).toHaveLength(1);
        expect(lifecycle.filter((event) => event.type === 'compositionend')).toEqual([
          expect.objectContaining({ data: syllable, isTrusted: trustedCompositionEnd }),
        ]);
        expect(lifecycle.at(-1)?.type).toBe('compositionend');
        await assertUnsent();
      } finally {
        try {
          // Persist raw isTrusted values and editor state even when a lifecycle
          // assertion fails, so a trace of CDP commands is not mistaken for proof.
          await testInfo.attach(`ime-${index === 0 ? 'idle' : 'busy'}-lifecycle`, {
            contentType: 'application/json',
            body: JSON.stringify({
              driver: 'Chromium CDP Input.imeSetComposition / Input.insertText',
              browserVersion: page.context().browser()!.version(),
              physicalWindowsIme: false,
              ...await ime.snapshot(),
            }, null, 2),
          });
        } finally {
          await ime.dispose();
        }
      }

      if (index === 0) {
        // Arm both exact responses before the first ordinary Enter. The form
        // save proves the held agent has armed its release-file watcher.
        const [started, formSaved] = await Promise.all([
          page.waitForResponse((response) => isRunStart(response, idlePrompt), { timeout: T.long }),
          page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'assistant'
            && message.content.includes(`id="${HELD_QUESTION_RUN.formId}"`)), { timeout: T.long }),
          input.press('Enter'),
        ]);
        for (const response of [started, formSaved]) expect(response.ok(), await response.text()).toBe(true);
        heldRunId = ((await started.json()) as { runId: string }).runId;
        expect(runRequests.map((run) => run.currentPrompt)).toEqual([idlePrompt]);
      } else {
        await input.press('Enter');
        await expect(page.getByTestId('chat-queued-send-strip').locator('.chat-queued-send-row')).toHaveCount(1);
        expect(await readQueue()).toEqual([expect.objectContaining({ conversationId, prompt: queuedPrompt })]);
        expect(runRequests.map((run) => run.currentPrompt)).toEqual([idlePrompt]);
      }
      await expect(input).toHaveText('');
    }

    // Releasing the real held run promotes the one queued Korean draft. Exact
    // saved messages and wire prompts prove text was committed/submitted once,
    // not merely painted once in the contenteditable DOM.
    const [heldSaved, promoted, answerSaved, promotedSaved] = await Promise.all([
      page.waitForResponse((response) => isMessageSave(response, (message) => message.runId === heldRunId
        && message.runStatus === 'succeeded'), { timeout: T.long }),
      page.waitForResponse((response) => isRunStart(response, queuedPrompt), { timeout: T.long }),
      page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'user'
        && message.content === queuedPrompt), { timeout: T.long }),
      page.waitForResponse((response) => isMessageSave(response, (message) => message.role === 'assistant'
        && message.runId !== heldRunId && message.runStatus === 'succeeded'), { timeout: T.long }),
      (async () => {
        const released = await request.post(`/api/projects/${projectId}/files`, { data: {
          name: HELD_QUESTION_RUN.releaseFile, content: HELD_QUESTION_RUN.releaseToken,
        } });
        expect(released.ok(), await released.text()).toBe(true);
      })(),
    ]);
    for (const response of [heldSaved, promoted, answerSaved, promotedSaved]) expect(response.ok(), await response.text()).toBe(true);
    const artifact = page.frameLocator('[data-testid="artifact-preview-frame"]');
    await expect(artifact.getByRole('heading', { name: 'Fake Agent Runtime codex' })).toBeVisible();
    await expect(artifact.getByText('Generated through fake codex runtime.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('chat-queued-send-strip')).toHaveCount(0);
    expect(await readQueue()).toEqual([]);
    expect(runRequests.map((run) => run.currentPrompt)).toEqual([idlePrompt, queuedPrompt]);
    expect((await messages()).filter((message) => message.role === 'user').map((message) => message.content))
      .toEqual([idlePrompt, queuedPrompt]);
    expect((await runs()).map((run) => run.status)).toEqual(['succeeded', 'succeeded']);
    await expect(input).toHaveText('');
  } finally {
    page.off('request', observeRun);
    try {
      try {
        await fileHydration.drain(T.long, 'raw');
      } finally {
        // Validation failure must not bypass unmount and produce deletion 404s.
        // The observer covers the mounted case, not teardown-induced aborts.
        fileHydration.dispose();
        await page.close();
        if (projectId && conversationId) {
          await cleanupHydrationRuns(request, projectId, conversationId, true);
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
});
