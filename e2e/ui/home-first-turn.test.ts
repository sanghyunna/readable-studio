import { expect, test, type Request, type Response } from '@playwright/test';
import type { ChatRequest, ChatRunListResponse, CreateProjectResponse, MessagesResponse } from '@readable-studio/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAgentRuntimes } from '@/fake-agents';
import { enterHomeFirstTurnPrompt } from '@/playwright/home-first-turn';
import { observeProjectFileHydration } from '@/playwright/project-file-hydration';
import { cleanupHydrationRuns } from '@/playwright/question-hydration';
import { routeAgents } from '@/playwright/mock-factory';
import { T } from '@/timeouts';
import { addStorageInitScript } from '@/playwright/storage-init';

// Fresh Playwright contexts; only agent discovery is mocked. Project creation,
// attachment upload, run start, SSE and message persistence use the real daemon.
for (const attachment of [false, true]) {
  test(`[P1] Home ${attachment ? 'prompt + attachment' : 'prompt'} starts exactly one first-turn run across reload`, async ({ page, request }, testInfo) => {
    test.setTimeout(T.xlong * 2);
    const root = await mkdtemp(join(tmpdir(), 'readable-home-first-turn-'));
    let savedConfig: Record<string, unknown> | undefined;
    let projectId: string | undefined;
    let conversationId: string | undefined;
    const prompt = `Create a deterministic smoke artifact ${attachment ? 'with attachment' : 'from prompt'}`;
    const projectPosts: Request[] = [];
    const runPosts: ChatRequest[] = [];
    const observeRequest = (incoming: Request) => {
      if (incoming.method() !== 'POST') return;
      const pathname = new URL(incoming.url()).pathname;
      if (pathname === '/api/projects') projectPosts.push(incoming);
      if (pathname === '/api/runs') runPosts.push(incoming.postDataJSON() as ChatRequest);
    };
    page.on('request', observeRequest);
    const fileHydration = observeProjectFileHydration(page);
    const runs = async () => {
      const response = await request.get('/api/runs', { params: { projectId: projectId!, conversationId: conversationId! } });
      expect(response.ok(), await response.text()).toBe(true);
      return ((await response.json()) as ChatRunListResponse).runs;
    };

    try {
      const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
      const initialConfig = await request.get('/api/app-config');
      expect(initialConfig.ok(), await initialConfig.text()).toBe(true);
      savedConfig = ((await initialConfig.json()) as { config: Record<string, unknown> }).config;
      const config = {
        ...savedConfig, mode: 'daemon', agentId: 'codex', skillId: null, designSystemId: null,
        onboardingCompleted: true, privacyDecisionAt: 1,
        telemetry: { metrics: false, content: false, artifactManifest: false },
        // Explicit test selection, not an application default or guard bypass.
        agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } },
        agentCliEnv: { codex: codex.env },
      };
      const configured = await request.put('/api/app-config', { data: config });
      expect(configured.ok(), await configured.text()).toBe(true);
      await routeAgents(page, [{
        id: 'codex', name: 'Codex', bin: codex.bin, available: true, version: 'test',
        models: [{ id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' }],
      }]);
      await addStorageInitScript(page, (initial) => {
        if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
        if (!localStorage.getItem('readable-studio:config')) {
          localStorage.setItem('readable-studio:config', JSON.stringify(initial));
        }
        localStorage.setItem('readable-studio:locale', 'en');
        localStorage.setItem('readable-studio:locale-source', 'manual');
      }, config);
      await page.goto('/');
      await expect(page.getByTestId('home-hero-agent-model').getByTestId('inline-model-switcher-model-label'))
        .toHaveText('GPT-5.4-Mini');
      await expect(page.getByTestId('new-project-modal')).toHaveCount(0);
      await enterHomeFirstTurnPrompt(page, prompt);
      if (attachment) {
        await page.getByTestId('home-hero-file-input').setInputFiles({
          name: 'first-turn-brief.txt', mimeType: 'text/plain', buffer: Buffer.from('First-turn reference content.'),
        });
        await expect(page.getByTestId('home-hero').getByText('first-turn-brief.txt', { exact: true })).toBeVisible();
      }
      expect(projectPosts).toHaveLength(0);
      expect(runPosts).toHaveLength(0);
      const isPost = (response: Response, pathname: string) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === pathname;
      // Install every response subscription before the single real submit.
      const [created, started, terminal] = await Promise.all([
        page.waitForResponse((response) => isPost(response, '/api/projects'), { timeout: T.long }),
        page.waitForResponse((response) => isPost(response, '/api/runs')
          && (response.request().postDataJSON() as ChatRequest).currentPrompt === prompt, { timeout: T.long }),
        page.waitForResponse((response) => response.request().method() === 'PUT'
          && /\/conversations\/[^/]+\/messages\//.test(new URL(response.url()).pathname)
          && response.request().postDataJSON().role === 'assistant'
          && response.request().postDataJSON().runStatus === 'succeeded', { timeout: T.long }),
        page.getByTestId('home-hero-submit').click(),
      ]);
      for (const response of [created, started, terminal]) expect(response.ok(), await response.text()).toBe(true);
      const creation = await created.json() as CreateProjectResponse;
      projectId = creation.project.id;
      conversationId = creation.conversationId;
      if (!conversationId) throw new Error('Home-created project has no default conversation');
      const runId = ((await started.json()) as { runId: string }).runId;
      expect(projectPosts).toHaveLength(1);
      expect(projectPosts[0]!.postDataJSON()).toMatchObject({ pendingPrompt: prompt, conversationMode: 'design' });
      expect(runPosts).toHaveLength(1);
      expect(runPosts[0]).toMatchObject({ projectId, conversationId, currentPrompt: prompt, agentId: 'codex', sessionMode: 'design' });
      expect(runPosts[0]!.attachments).toHaveLength(attachment ? 1 : 0);
      if (attachment) expect(runPosts[0]!.attachments![0]).toContain('first-turn-brief.txt');
      expect(terminal.request().postDataJSON()).toMatchObject({ runId, role: 'assistant', runStatus: 'succeeded' });
      await expect(page.locator('.msg.user').filter({ hasText: prompt })).toBeVisible();

      const artifact = page.frameLocator('[data-testid="artifact-preview-frame"]');
      await expect(artifact.getByRole('heading', { name: 'Real Daemon Smoke' })).toBeVisible();
      await expect(artifact.getByText('Generated through the daemon run path.', { exact: true })).toBeVisible();
      await fileHydration.drain(T.long, 'raw');
      const rawFinishedBeforeReload = fileHydration.counts.rawFinished;

      // A completed first turn has no pending handoff/queue/question, so its
      // reload need not issue an active-run GET. Observe real message hydration.
      const [hydrated] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'GET'
          && new URL(response.url()).pathname === `/api/projects/${projectId}/conversations/${conversationId}/messages`,
        { timeout: T.long }),
        page.reload(),
      ]);
      expect(hydrated.ok(), await hydrated.text()).toBe(true);
      await expect(artifact.getByRole('heading', { name: 'Real Daemon Smoke' })).toBeVisible();
      await expect(artifact.getByText('Generated through the daemon run path.', { exact: true })).toBeVisible();
      await fileHydration.drain(T.long, 'raw');
      expect(fileHydration.counts.rawFinished, JSON.stringify(fileHydration.counts)).toBeGreaterThan(rawFinishedBeforeReload);
      await expect(page.locator('.msg.user').filter({ hasText: prompt })).toBeVisible();
      expect(projectPosts).toHaveLength(1);
      expect(runPosts).toHaveLength(1);
      expect((await runs()).map(({ id, status }) => ({ id, status }))).toEqual([{ id: runId, status: 'succeeded' }]);
      const messagesResponse = await request.get(`/api/projects/${projectId}/conversations/${conversationId}/messages`);
      expect(messagesResponse.ok(), await messagesResponse.text()).toBe(true);
      const messages = ((await messagesResponse.json()) as MessagesResponse).messages;
      const userTurns = messages.filter((message) => message.role === 'user');
      expect(userTurns).toHaveLength(1);
      expect(userTurns[0]).toMatchObject({ content: prompt, sessionMode: 'design' });
      expect(userTurns[0]!.attachments ?? []).toHaveLength(attachment ? 1 : 0);
      if (attachment) expect(userTurns[0]!.attachments![0]).toMatchObject({ name: 'first-turn-brief.txt', kind: 'file' });
      expect(await page.evaluate((id) => sessionStorage.getItem(`readable:auto-send-first:${id}`), projectId)).toBeNull();
    } finally {
      page.off('request', observeRequest);
      try {
        try {
          await fileHydration.drain(T.long, 'raw');
        } finally {
          // Even failed hydration must unmount before run cleanup/deletion.
          fileHydration.dispose();
          await page.close();
          // Creation may have succeeded before a later run/terminal waiter failed.
          if (!projectId && projectPosts[0]) projectId = (projectPosts[0].postDataJSON() as { id: string }).id;
          try {
            if (projectId && conversationId) {
              await cleanupHydrationRuns(request, projectId, conversationId, false);
            }
          } finally {
            if (projectId) {
              const deleted = await request.delete(`/api/projects/${projectId}`);
              expect(deleted.ok(), await deleted.text()).toBe(true);
            }
          }
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
  });
}
