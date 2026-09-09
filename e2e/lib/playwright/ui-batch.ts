import { expect, test as base, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { ChatMessage, ChatRequest, CreateProjectResponse, ProjectMetadata } from '@readable-studio/contracts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createFakeAgentRuntimes } from '../fake-agents.ts';
import { cleanupHydrationRuns } from './question-hydration.ts';
import { routeAgents } from './mock-factory.ts';
import { addStorageInitScript } from './storage-init.ts';
import { T } from '../timeouts.ts';

export const MODEL = 'gpt-5.4-mini';
export const PREVIEW = '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible';
export const HTML = '<!doctype html><html><body><h1 data-readable-id="acceptance-title" style="font-size:24px">Acceptance document</h1></body></html>';
export const FORM_ID = 'ui-batch-intake';
export const INTAKE = {
  questions: [
    { id: 'delivery', label: 'Delivery format', type: 'select', required: true,
      options: [{ value: 'html', label: 'HTML' }, { value: 'markdown', label: 'Markdown' }, { value: 'slides', label: 'Slides' }] },
    { id: 'audience', label: 'Audience', type: 'textarea', required: true },
  ],
};

export async function checked(response: APIResponse | Response) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response;
}

interface Batch {
  configure(options?: { theme?: 'light' | 'dark'; unselected?: boolean }): Promise<void>;
  create(metadata?: ProjectMetadata, designSystemId?: string): Promise<{ id: string; conversationId: string }>;
  own(id: string, conversationId?: string): void;
  seedForm(id: string, conversationId: string): Promise<void>;
  runs: ChatRequest[];
}

// The shared Playwright runtime owns its daemon namespace. Each case owns UUID
// projects, an executable fake CLI and a restored daemon config within it.
export const test = base.extend<{ batch: Batch }>({
  batch: async ({ page, request }, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), 'readable-ui-batch-'));
    const projects = new Map<string, string | undefined>();
    const runs: ChatRequest[] = [];
    const optionalAmrFailures: string[] = [];
    const ownershipReads: Promise<void>[] = [];
    const configResponse = await checked(await request.get('/api/app-config'));
    const savedConfig = (await configResponse.json() as { config: Record<string, unknown> }).config;
    const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
    const observe = (response: Response) => {
      const url = new URL(response.url());
      // Optional AMR discovery is evidence, not a prerequisite for local CLI workflows.
      if (response.status() >= 500 && /\/amr(?:\/|$)/.test(url.pathname)) optionalAmrFailures.push(`${response.status()} ${url.pathname}`);
      // Register UI-created projects even if a later upload/assertion fails.
      if (response.ok() && response.request().method() === 'POST' && url.pathname === '/api/projects') {
        const ownership = response.json().then((value: CreateProjectResponse) => {
          projects.set(value.project.id, value.conversationId ?? undefined);
        });
        ownershipReads.push(ownership);
      }
    };
    page.on('response', observe);
    page.on('request', (incoming) => {
      if (incoming.method() === 'POST' && new URL(incoming.url()).pathname === '/api/runs') runs.push(incoming.postDataJSON() as ChatRequest);
    });
    try {
      await use({
        runs,
        own: (id, conversationId) => { projects.set(id, conversationId); },
        async configure({ theme = 'light', unselected = false } = {}) {
          const config = {
            ...savedConfig, mode: 'daemon', agentId: 'codex', model: '', theme,
            skillId: null, designSystemId: null, onboardingCompleted: true, privacyDecisionAt: 1,
            telemetry: { metrics: false, content: false, artifactManifest: false },
            agentModels: unselected ? {} : { codex: { model: MODEL, reasoning: 'default' } },
            agentCliEnv: { codex: codex.env },
          };
          await checked(await request.put('/api/app-config', { data: config }));
          // Concrete-only catalog is important: [] or [{id:'default'}] means
          // the CLI owns model selection and intentionally bypasses the guard.
          await routeAgents(page, [{ id: 'codex', name: 'Codex', bin: codex.bin, available: true,
            version: 'e2e', supportsCustomModel: false, models: [{ id: MODEL, label: 'GPT-5.4 Mini' }] }]);
          await addStorageInitScript(page, (initial) => {
            if (!localStorage.getItem('readable-studio:config')) localStorage.setItem('readable-studio:config', JSON.stringify(initial));
            localStorage.setItem('readable-studio:locale', 'en');
            localStorage.setItem('readable-studio:locale-source', 'manual');
          }, config);
        },
        async create(metadata = { kind: 'prototype' }, designSystemId) {
          const id = randomUUID();
          projects.set(id, undefined);
          const response = await checked(await request.post('/api/projects', { data: {
            id, name: `UI acceptance ${id}`, skillId: null, designSystemId: designSystemId ?? null,
            conversationMode: 'design', metadata,
          } }));
          const created = await response.json() as CreateProjectResponse;
          if (!created.conversationId) throw new Error('Project has no default conversation');
          projects.set(id, created.conversationId);
          return { id, conversationId: created.conversationId };
        },
        async seedForm(id, conversationId) {
          const message: ChatMessage = { id: randomUUID(), role: 'assistant', createdAt: Date.now(),
            content: `<question-form id="${FORM_ID}" title="Document intake">${JSON.stringify(INTAKE)}</question-form>` };
          await checked(await request.put(`/api/projects/${id}/conversations/${conversationId}/messages/${message.id}`, { data: message }));
        },
      });
    } finally {
      page.off('response', observe);
      // Unmount before cancellation so queued answers cannot auto-promote.
      const ownership = await Promise.allSettled(ownershipReads);
      await page.close();
      const cleanup = await Promise.allSettled([...projects].map(async ([id, conversationId]) => {
        // A failed import may already have rolled its project back.
        const exists = await request.get(`/api/projects/${id}`);
        if (exists.status() === 404) return;
        await checked(exists);
        try {
          if (conversationId) await cleanupHydrationRuns(request, id, conversationId, true);
        } finally {
          await checked(await request.delete(`/api/projects/${id}`));
        }
      }));
      try {
        await checked(await request.put('/api/app-config', { data: savedConfig }));
      } finally {
        await testInfo.attach('optional-amr-failures', { contentType: 'application/json', body: JSON.stringify(optionalAmrFailures) });
        await rm(root, { recursive: true, force: true });
      }
      const failures = [...ownership, ...cleanup].filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), 'UI acceptance cleanup failed');
    }
  },
});

export function isApi(response: Response, method: string, path: string) {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}

export function terminalMessage(response: Response, id: string, conversationId: string) {
  return response.request().method() === 'PUT'
    && new URL(response.url()).pathname.startsWith(`/api/projects/${id}/conversations/${conversationId}/messages/`)
    && (response.request().postDataJSON() as ChatMessage).role === 'assistant'
    && (response.request().postDataJSON() as ChatMessage).runStatus === 'succeeded';
}

export async function questionsCli(action: 'get' | 'set', id: string, ...args: string[]) {
  // Execute the shipped CLI boundary, never import daemon internals. The
  // Playwright tools-dev runtime has already built this public bin's dist.
  const bin = fileURLToPath(new URL('../../../apps/daemon/bin/readable.mjs', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, READABLE_DAEMON_URL: `http://127.0.0.1:${Number(process.env.READABLE_PORT) || 17456}` };
  // Playwright forces color for its workers, which conflicts with an inherited
  // NO_COLOR in Node. This JSON-only child must not inherit that override.
  delete env.FORCE_COLOR;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, 'project', 'questions', action, id, ...args, '--json'], {
    env,
    timeout: T.long,
  });
  expect(stderr).toBe('');
  return JSON.parse(stdout) as { brief: { assumptions: Array<{ id: string; value: string; provenance: string }> } };
}

export interface DropFile { name: string; type: string; content: string }
export async function dropFiles(target: Locator, files: DropFile[], twice = false) {
  // Both events occur in one browser task: this exercises the busy ref, not
  // timing luck between two separately awaited Playwright actions.
  await target.evaluate((element, payload) => {
    const transfer = new DataTransfer();
    for (const file of payload.files) transfer.items.add(new File([file.content], file.name, { type: file.type }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    for (let index = 0; index < (payload.twice ? 2 : 1); index++) {
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, { files, twice });
}

export async function screenshot(page: Page, name: string) {
  await test.info().attach(name, { contentType: 'image/png', body: await page.screenshot({ fullPage: true }) });
}
