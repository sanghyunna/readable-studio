import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Script } from 'node:vm';
import { chromium, expect as uiExpect, request as apiRequest, type APIRequestContext, type Frame, type Page, type Request, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, CreateProjectResponse, MessagesResponse, ProjectFile } from '@readable-studio/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ARTIFACT_DEDUP_RUN as sentinel, createFakeAgentRuntimes } from '@/fake-agents';
import { waitForLoadingToClear } from '@/playwright/amr';
import { routeAgents } from '@/playwright/mock-factory';
import { observeProjectFileHydration } from '@/playwright/project-file-hydration';
import { cleanupHydrationRuns } from '@/playwright/question-hydration';
import { addStorageInitScript } from '@/playwright/storage-init';
import { createSmokeSuite, e2eWorkspaceRoot } from '@/smoke-suite';
import { T } from '@/timeouts';

type Scenario = keyof typeof sentinel.prompts;
const scenarios: Scenario[] = ['identical', 'differing', 'historical'];
const namedFile = `${sentinel.identifier}.html`;

// Like artifact-consistency.test.ts, this cross-app test needs the actual
// ProjectView persistence path. Never emulate that path by POSTing the emitted
// artifact ourselves. The static group is independently runnable without any
// daemon/browser; generated compatibility runners live only in the OS temp root.
describe('artifact dedup static fake-agent protocol', () => {
  let root: string;
  let script: Script;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'readable-artifact-dedup-static-'));
    await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
    script = new Script(await readFile(join(root, 'codex-e2e.cjs'), 'utf8'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function fixture(writeError?: Error, cwdArgs = ['-C', root], env: Record<string, string> = { READABLE_PROJECT_DIR: root }) {
    const stdin = Object.assign(new EventEmitter(), { setEncoding() {}, resume() {}, isTTY: false });
    const frames: Array<{ type: string; item?: { type: string; text: string } }> = [];
    const writes: Array<{ file: string; content: string; encoding: string }> = [];
    const stderr: string[] = [];
    const exits: number[] = [];
    const timers: number[] = [];
    const order: string[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    let commit!: () => void;
    const writeCommitted = new Promise<void>((resolve) => { commit = resolve; });
    const processDouble = {
      // Model the launcher cwd separately from the daemon-assigned project.
      argv: ['node', 'codex-e2e.cjs', 'exec', ...cwdArgs], env, stdin,
      cwd: e2eWorkspaceRoot, exitCode: undefined as number | undefined,
      stdout: { write(text: string, callback?: () => void) {
        for (const line of text.split('\n').filter(Boolean)) {
          frames.push(JSON.parse(line));
          order.push('frame');
        }
        callback?.();
        return true;
      } },
      stderr: { write(text: string) { stderr.push(text); finish(); return true; } },
      exit(code: number) { exits.push(code); finish(); },
    };
    script.runInNewContext({
      process: processDouble,
      require(name: string) {
        if (name === 'node:path') return { isAbsolute, join };
        if (name === 'node:fs') return {};
        if (name === 'node:fs/promises') return {
          async writeFile(file: string, content: string, encoding: string) {
            writes.push({ file, content, encoding });
            await writeCommitted;
            if (writeError) throw writeError;
            order.push('write-committed');
          },
        };
        throw new Error(`Unexpected fixture import: ${name}`);
      },
      // No real timers: a successful sentinel must flush instead of exitSoon.
      setTimeout(_callback: () => void, ms: number) { timers.push(ms); return timers.length; },
      clearTimeout() {},
    });
    return { stdin, frames, writes, stderr, exits, timers, order, completed, commit, processDouble };
  }

  test.each(scenarios)('%s dispatches only after EOF and emits one full artifact after committed writes', async (scenario) => {
    const value = fixture(undefined, [scenario === 'differing' ? '--cd' : '-C', root], {
      READABLE_PROJECT_DIR: join(root, 'not-the-cli-workspace'),
    });
    value.stdin.emit('data', 'System envelope remains intact.\n\n## user\n');
    value.stdin.emit('data', sentinel.prompts[scenario]);
    expect(value.writes).toEqual([]);
    expect(value.frames).toEqual([]);
    value.stdin.emit('end');
    if (scenario !== 'historical') {
      expect(value.writes).toEqual([{ file: join(root, sentinel.fileName), content: sentinel.html, encoding: 'utf8' }]);
      expect(value.frames).toEqual([]);
      value.commit();
    }
    await value.completed;
    expect(value.writes).toHaveLength(scenario === 'historical' ? 0 : 1);
    expect(value.frames.map((frame) => frame.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    const item = value.frames[2]!.item!;
    expect(item.type).toBe('agent_message');
    const artifact = /^<artifact identifier="([^"]+)" type="([^"]+)"[^>]*>([\s\S]*)<\/artifact>$/.exec(item.text);
    expect(artifact?.slice(1)).toEqual([sentinel.identifier, 'text/html', scenario === 'differing' ? sentinel.differingHtml : sentinel.html]);
    if (scenario !== 'historical') expect(value.order[0]).toBe('write-committed');
    expect(value.exits).toEqual([0]);
    expect(value.stderr).toEqual([]);
    expect(value.timers).toEqual([]);
    value.stdin.emit('end');
    expect(value.frames).toHaveLength(4);
  });

  test('historical and background-memory mentions cannot write index or replace the latest response', () => {
    for (const prompt of [
      `## user\n${sentinel.prompts.identical}\n\n## assistant\nprevious output\n\n## user\nOrdinary follow-up`,
      `## Existing memory\n(empty)\n\n## User message\n## user\n${sentinel.prompts.identical}\n\n## Assistant reply\n${sentinel.html}\n\nReturn ONLY the JSON object described in the system prompt.`,
      `## User message\n${sentinel.prompts.identical}\n\nReturn ONLY JSON.`,
    ]) {
      const value = fixture();
      value.stdin.emit('data', prompt);
      value.stdin.emit('end');
      expect(value.writes).toEqual([]);
      expect(value.frames.filter((frame) => frame.type === 'turn.completed')).toHaveLength(1);
      expect(value.frames.some((frame) => frame.item?.text.includes(`identifier="${sentinel.identifier}"`))).toBe(false);
    }
  });

  test('missing, relative and failed project writes cannot emit an artifact or a successful terminal frame', async () => {
    for (const cwdArgs of [[], ['-C', 'relative-project'], ['-C'], ['-C', e2eWorkspaceRoot()]]) {
      const value = fixture(undefined, cwdArgs, {});
      value.stdin.emit('data', `## user\n${sentinel.prompts.identical}`);
      value.stdin.emit('end');
      await value.completed;
      expect(value.writes).toEqual([]);
      expect(value.frames).toEqual([]);
      expect(value.stderr).toHaveLength(1);
      expect(value.processDouble.exitCode).toBe(1);
    }
    // Runtimes without a cwd flag use the daemon's explicit project env, never
    // the inherited cwd. A rejected filesystem write still fails the run.
    const value = fixture(new Error('fixture write denied'), [], { READABLE_PROJECT_DIR: root });
    value.stdin.emit('data', `## user\n${sentinel.prompts.identical}`);
    value.stdin.emit('end');
    expect(value.writes).toEqual([{ file: join(root, sentinel.fileName), content: sentinel.html, encoding: 'utf8' }]);
    value.commit();
    await value.completed;
    expect(value.frames).toEqual([]);
    expect(value.stderr).toHaveLength(1);
    expect(value.processDouble.exitCode).toBe(1);
    expect(value.exits).toEqual([]);
  });
});

// Run explicitly with -t 'artifact dedup real daemon'. Static validation never
// launches this group. One runtime/browser serves all three sequential scenarios;
// each owns a fresh context, project and conversation. Keep the suite name short:
// tools-dev repeats it in Next's output path (long names hit Windows MAX_PATH).
describe('artifact dedup real daemon', () => {
  test('[P1] identical, differing and historical preserve exact files through live completion and reload/replay', async () => {
    const untrackedFiles = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: e2eWorkspaceRoot(), encoding: 'utf8',
    }).split(/\r?\n/).filter((line) => line.startsWith('?? '));
    const initialUntrackedFiles = new Set(untrackedFiles());
    const suite = await createSmokeSuite('ad');
    const root = await mkdtemp(join(tmpdir(), 'readable-artifact-dedup-'));
    try {
      const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
      await suite.with.toolsDev(async ({ webUrl }) => {
        const request = await apiRequest.newContext({ baseURL: webUrl });
        try {
          const config = {
            mode: 'daemon', agentId: 'codex', skillId: null, designSystemId: null,
            onboardingCompleted: true, privacyDecisionAt: 1,
            telemetry: { metrics: false, content: false, artifactManifest: false },
            agentModels: { codex: { model: 'gpt-5.4-mini', reasoning: 'default' } },
            agentCliEnv: { codex: codex.env },
          };
          const configured = await request.put('/api/app-config', { data: config });
          expect(configured.ok(), await configured.text()).toBe(true);
          const browser = await chromium.launch();
          try {
            for (const scenario of scenarios) {
              const created = await request.post('/api/projects', { data: {
                id: randomUUID(), name: `Artifact dedup ${scenario}`, metadata: { kind: 'prototype' },
                skillId: null, designSystemId: null, pendingPrompt: null,
              } });
              expect(created.ok(), await created.text()).toBe(true);
              const { project, conversationId } = await created.json() as CreateProjectResponse;
              const projectPath = `/api/projects/${project.id}`;
              try {
                if (!conversationId) throw new Error('Missing default conversation');
                const messagesPath = `${projectPath}/conversations/${conversationId}/messages`;
                const context = await browser.newContext({ baseURL: webUrl });
                try {
                  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
                  const page = await context.newPage();
                  const browserDiagnostics: unknown[] = [];
                  page.on('console', (message) => browserDiagnostics.push({ type: 'console', level: message.type(), text: message.text() }));
                  page.on('pageerror', (error) => browserDiagnostics.push({ type: 'pageerror', text: error.stack ?? error.message }));
                  page.on('requestfailed', (request) => browserDiagnostics.push({ type: 'requestfailed', url: request.url(), error: request.failure() }));
                  page.on('response', (response) => {
                    if (response.status() >= 400) browserDiagnostics.push({ type: 'http-error', url: response.url(), status: response.status() });
                  });
                  const hydration = observeProjectFileHydration(page);
                  try {
                    if (scenario === 'historical') {
                      const seeded = await request.post(`${projectPath}/files`, { data: { name: sentinel.fileName, content: sentinel.html } });
                      expect(seeded.ok(), await seeded.text()).toBe(true);
                    }
                    // Only discovery is mocked. Runs, prompt assembly, SSE, files,
                    // manifests, messages and reload hydration stay on the real APIs.
                    await routeAgents(page, [{ id: 'codex', name: 'Codex', bin: codex.bin,
                      available: true, version: 'test', models: [{ id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' }] }]);
                    await addStorageInitScript(context, (initial) => {
                      if (!['http:', 'https:'].includes(location.protocol)) return;
                      if (!localStorage.getItem('readable-studio:config')) localStorage.setItem('readable-studio:config', JSON.stringify(initial));
                      localStorage.setItem('readable-studio:locale', 'en');
                      localStorage.setItem('readable-studio:locale-source', 'manual');
                    }, config);
                    const initialMessages = await request.get(messagesPath);
                    expect(initialMessages.ok(), await initialMessages.text()).toBe(true);
                    expect((await initialMessages.json() as MessagesResponse).messages).toEqual([]);
                    const workspacePath = `/projects/${project.id}/conversations/${conversationId}`;
                    // A historical project already has a primary file; ProjectView
                    // selects it on first hydration and includes it in the URL.
                    const initialPath = scenario === 'historical' ? `${workspacePath}/files/${sentinel.fileName}` : workspacePath;
                    const navigation = await page.goto(initialPath, { waitUntil: 'domcontentloaded' });
                    expect(navigation?.ok(), `Workspace document returned ${navigation?.status()}`).toBe(true);
                    await expectDedupWorkspaceReady(page, initialPath);
                    const input = page.getByTestId('chat-composer-input');
                    await input.fill(sentinel.prompts[scenario]);
                    await uiExpect(page.getByTestId('chat-send')).toBeEnabled();
                    const expectedNames = scenario === 'identical' ? [sentinel.fileName] : [sentinel.fileName, namedFile].sort();
                    const [started, persisted] = await Promise.all([
                      page.waitForResponse((response) => response.request().method() === 'POST'
                        && new URL(response.url()).pathname === '/api/runs', { timeout: T.long }),
                      // The daemon end frame alone is too early: ProjectView still has
                      // to persist the artifact and then its producedFiles attachment.
                      page.waitForResponse((response) => isPersistedArtifactMessage(response, messagesPath), { timeout: T.long }),
                      page.getByTestId('chat-send').click(),
                    ]);
                    for (const response of [started, persisted]) expect(response.ok(), await response.text()).toBe(true);
                    const runRequest = started.request().postDataJSON() as ChatRequest;
                    expect(runRequest).toMatchObject({ currentPrompt: sentinel.prompts[scenario], projectId: project.id, conversationId, agentId: 'codex' });
                    expect(runRequest.message).toContain(sentinel.prompts[scenario]);
                    const { runId } = await started.json() as { runId: string };
                    const message = persisted.request().postDataJSON() as ChatMessage;
                    expect(message).toMatchObject({ runId, runStatus: 'succeeded', preTurnFileNames: scenario === 'historical' ? [sentinel.fileName] : [] });
                    const expectedProduced = scenario === 'historical' ? [namedFile] : expectedNames;
                    expect(message.producedFiles?.map((file) => file.name).sort()).toEqual(expectedProduced);
                    await assertTerminalReplay(request, runId, project.id, conversationId);
                    await assertFiles(request, projectPath, scenario, message.id, expectedNames);

                    const activeFile = scenario === 'identical' ? sentinel.fileName : namedFile;
                    const html = scenario === 'differing' ? sentinel.differingHtml : sentinel.html;
                    await uiExpect(page.getByTestId('file-workspace').getByText(activeFile, { exact: true }).first()).toBeVisible();
                    await hydration.drain(T.long, 'raw');
                    const [reloadedHtml, loaded] = await Promise.all([
                      readReloadedProjectSource(page, `${projectPath}/raw/${activeFile}`,
                        () => hydration.navigate(() => page.reload({ waitUntil: 'domcontentloaded' }))),
                      page.waitForResponse((response) => response.request().method() === 'GET'
                        && new URL(response.url()).pathname === messagesPath, { timeout: T.long }),
                    ]);
                    expect(loaded.ok(), await loaded.text()).toBe(true);
                    const { messages } = await loaded.json() as MessagesResponse;
                    expect(messages.filter((row) => row.role === 'assistant')).toHaveLength(1);
                    expect(messages.filter((row) => row.id === message.id)[0]).toMatchObject({ runId, runStatus: 'succeeded' });
                    expect(reloadedHtml).toBe(html);
                    await expectDedupWorkspaceReady(page, `${workspacePath}/files/${activeFile}`);
                    await uiExpect(page.getByTestId('file-workspace').getByText(activeFile, { exact: true }).first()).toBeVisible();
                    await hydration.drain(T.long, 'raw');
                    // A second real SSE subscription replays exactly one daemon end and
                    // closes. Reload must not create a second file or lose the binding.
                    await assertTerminalReplay(request, runId, project.id, conversationId);
                    await assertFiles(request, projectPath, scenario, message.id, expectedNames);
                    await suite.report.json(`artifact-dedup-${scenario}.json`, { scenario, projectId: project.id, conversationId, runId, messageId: message.id, expectedNames });
                  } catch (error) {
                    await suite.report.json(`artifact-dedup-${scenario}-failure.json`, {
                      url: page.url(), browserDiagnostics,
                      surface: await page.evaluate(() => ({
                        text: document.body.innerText,
                        testids: Array.from(document.querySelectorAll('[data-testid]')).map((node) => node.getAttribute('data-testid')),
                      })),
                    });
                    await suite.report.save(`artifact-dedup-${scenario}-failure.png`, await page.screenshot({ fullPage: true }));
                    throw error;
                  } finally {
                    hydration.dispose();
                    await context.tracing.stop({ path: join(suite.report.root, `artifact-dedup-${scenario}-trace.zip`) });
                  }
                } finally {
                  // Close every page and its routes/storage before cancellation;
                  // the independent API context stays alive to prove SSE EOF.
                  await context.close();
                }
              } finally {
                try {
                  if (conversationId) await cleanupHydrationRuns(request, project.id, conversationId, false);
                } finally {
                  const deleted = await request.delete(projectPath);
                  expect(deleted.ok(), await deleted.text()).toBe(true);
                }
              }
            }
          } finally {
            await browser.close();
          }
        } finally {
          await request.dispose();
        }
      }, {
        // Vitest supplies NODE_ENV=test; the web config treats every value other
        // than development as production and enables static export. Match the
        // tools-dev runtime used by the UI specs so deep links AND real reloads
        // reach the SPA instead of Next's generateStaticParams error page.
        env: { NODE_ENV: 'development' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      expect(untrackedFiles().filter((file) => !initialUntrackedFiles.has(file)), 'Fixture leaked files into the repository').toEqual([]);
    }
  }, T.xlong * 3);
});

async function readReloadedProjectSource(page: Page, rawPath: string, reload: () => Promise<unknown>) {
  let committed = false;
  const sourceRequests = new Set<Request>();
  const onNavigation = (frame: Frame) => { if (frame === page.mainFrame()) committed = true; };
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    // Ignore the outgoing document and preview iframe responses, which contain
    // injected bridge scripts rather than the persisted source bytes.
    if (committed && request.method() === 'GET' && url.pathname === rawPath
      && !url.searchParams.has('odPreviewBridge')) sourceRequests.add(request);
  };
  page.on('framenavigated', onNavigation);
  page.on('request', onRequest);
  try {
    const body = page.waitForEvent('requestfinished', {
      timeout: T.long, predicate: (request) => sourceRequests.has(request),
    }).then(async (request) => {
      const response = await request.response();
      expect(response?.ok()).toBe(true);
      return response!.text();
    });
    const [text] = await Promise.all([body, reload()]);
    return text;
  } finally {
    page.off('framenavigated', onNavigation);
    page.off('request', onRequest);
  }
}

async function expectDedupWorkspaceReady(page: Page, workspacePath: string) {
  await waitForLoadingToClear(page);
  await uiExpect(page).toHaveURL((url) => url.pathname.replace(/\/+$/, '') === workspacePath.replace(/\/+$/, ''), { timeout: T.medium });
  await uiExpect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
  const input = page.getByTestId('chat-composer-input');
  await uiExpect(input).toBeVisible({ timeout: T.medium });
  await uiExpect(input).toBeEditable({ timeout: T.medium });
}

function isPersistedArtifactMessage(response: Response, messagesPath: string): boolean {
  if (response.request().method() !== 'PUT' || !new URL(response.url()).pathname.startsWith(`${messagesPath}/`)) return false;
  const body = response.request().postDataJSON() as ChatMessage;
  return body.role === 'assistant' && body.runStatus === 'succeeded' && (body.producedFiles?.length ?? 0) > 0;
}

async function assertFiles(request: APIRequestContext, projectPath: string, scenario: Scenario, messageId: string, expectedNames: string[]) {
  const response = await request.get(`${projectPath}/files`);
  expect(response.ok(), await response.text()).toBe(true);
  const { files } = await response.json() as { files: ProjectFile[] };
  const rootHtml = files.filter((file) => /^[^/\\]+\.html$/i.test(file.name));
  expect(rootHtml.map((file) => file.name).sort()).toEqual(expectedNames);
  for (const file of rootHtml) {
    const content = await request.get(`${projectPath}/files/${file.name}`);
    expect(content.ok(), await content.text()).toBe(true);
    expect(await content.text()).toBe(scenario === 'differing' && file.name === namedFile ? sentinel.differingHtml : sentinel.html);
  }
  const boundName = scenario === 'identical' ? sentinel.fileName : namedFile;
  expect(rootHtml.filter((file) => file.name === boundName)[0]?.artifactManifest).toMatchObject({
    entry: boundName, renderer: 'html', metadata: { identifier: sentinel.identifier, messageId, inferred: false },
  });
  if (scenario === 'historical') {
    expect(rootHtml.filter((file) => file.name === sentinel.fileName)[0]?.artifactManifest?.metadata?.identifier).not.toBe(sentinel.identifier);
  }
}

async function assertTerminalReplay(request: APIRequestContext, runId: string, projectId: string, conversationId: string) {
  // APIRequestContext buffers to EOF. This cannot mistake agent turn.completed
  // for daemon completion, nor leave an unbounded open EventSource behind.
  const events = await request.get(`/api/runs/${runId}/events`, { timeout: T.long });
  expect(events.ok(), await events.text()).toBe(true);
  const ends = (await events.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
    const lines = frame.split(/\r?\n/);
    if (!lines.includes('event: end')) return [];
    return [JSON.parse(lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n'))];
  });
  expect(ends).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  const status = await request.get(`/api/runs/${runId}`, { timeout: T.long });
  expect(status.ok(), await status.text()).toBe(true);
  expect(await status.json()).toMatchObject({ id: runId, projectId, conversationId, status: 'succeeded' });
}
