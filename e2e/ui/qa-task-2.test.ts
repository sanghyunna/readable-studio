// QA for todo 2: the five hub miswirings.
//
// Each assertion is made against observable state - a daemon payload, a
// re-issued request, rendered text - never by reading a handler. The hub is the
// entry surface at `/`, so every scenario starts there.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { openNewProjectModal } from '@/playwright/new-project-modal';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

async function gotoHub(page: Page) {
  await page.goto('/');
  const privacyDialog = page.getByRole('dialog').filter({ hasText: /Help us improve/i });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog
      .getByRole('button', { name: /I get it|not now|got it|don't share/i })
      .click();
  }
  await expect(page.getByTestId('hub-nav')).toBeVisible();
}

async function createProject(page: Page, name: string) {
  const response = await page.request.post('/api/projects', {
    data: {
      id: `qa-task-2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as { project: { id: string; name: string } };
  return body.project;
}

async function listConversations(page: Page, projectId: string) {
  const response = await page.request.get(`/api/projects/${projectId}/conversations`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = (await response.json()) as {
    conversations: { id: string; messageCount?: number }[];
  };
  return body.conversations;
}

/**
 * Creating a project also creates one empty conversation, and the hub is
 * REQUIRED to reuse an empty session instead of stacking another one on top.
 * Seeding a message into that conversation is what makes the create path the
 * one under test.
 */
async function fillDefaultConversation(page: Page, projectId: string) {
  const existing = await listConversations(page, projectId);
  expect(existing.length).toBeGreaterThan(0);
  const seeded = await page.request.post(`/api/projects/${projectId}/conversations`, {
    data: {
      title: 'qa-task-2 seeded history',
      seedMessages: [{ id: 'seed-1', role: 'user', content: 'seeded so this session is not empty' }],
    },
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  // Remove the auto-created empty one so only the non-empty session remains.
  for (const conversation of existing) {
    const deleted = await page.request.delete(
      `/api/projects/${projectId}/conversations/${conversation.id}`,
    );
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
  }
  const after = await listConversations(page, projectId);
  expect(after).toHaveLength(1);
  expect(after[0]!.messageCount ?? 0).toBeGreaterThan(0);
  return after[0]!;
}

test('[P1] the folder starter runs the real folder import instead of opening the Other tab', async ({
  page,
}) => {
  // The native picker cannot open in CI, so only the picker RESPONSE is
  // stubbed. Everything after it - the import POST, the project it creates -
  // is the real daemon, which is what makes this a proof and not a mock.
  const baseDir = await mkdtemp(join(tmpdir(), 'qa-task-2-folder-'));
  await writeFile(join(baseDir, 'index.html'), '<!doctype html><title>qa</title>', 'utf8');

  await page.route('**/api/dialog/open-folder', async (route) => {
    await route.fulfill({ json: { path: baseDir } });
  });

  const importRequests: string[] = [];
  const importResponses: string[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/import/folder' && request.method() === 'POST') {
      importRequests.push(request.postData() ?? '');
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/import/folder' && response.request().method() === 'POST') {
      void response
        .text()
        .then((text) => importResponses.push(text))
        .catch(() => undefined);
    }
  });

  await gotoHub(page);
  await openNewProjectModal(page);

  const starter = page.getByTestId('new-project-import-folder');
  await expect(starter).toBeVisible();
  await starter.click();

  // Proof 1: the real import endpoint was called with the picked folder.
  await expect
    .poll(() => importRequests.length, { timeout: 20_000 })
    .toBeGreaterThan(0);
  expect(importRequests[0]).toContain(baseDir.replaceAll('\\', '\\\\'));
  await expect.poll(() => importResponses.length, { timeout: 20_000 }).toBeGreaterThan(0);

  // Proof 2: the daemon created a project rooted at the picked folder and the
  // app opened it. `GET /api/projects` deliberately hides projects outside the
  // configured locations, so the import RESPONSE is the authoritative payload.
  // The imported folder is recorded on `project.metadata.baseDir`; the row has
  // no top-level `baseDir` column.
  const importBody = JSON.parse(importResponses[0] ?? '{}') as {
    project?: { id?: string; metadata?: { baseDir?: string | null; importedFrom?: string } };
  };
  expect(importBody.project?.id, importResponses[0]).toBeTruthy();
  expect((importBody.project?.metadata?.baseDir ?? '').toLowerCase()).toContain(
    'qa-task-2-folder-',
  );
  expect(importBody.project?.metadata?.importedFrom).toBe('folder');
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain(importBody.project!.id!);
});

test('[P1] the hub exposes the Claude ZIP starter and surfaces its failure', async ({ page }) => {
  await gotoHub(page);
  await openNewProjectModal(page);

  // The controller must surface a REJECTED import instead of silently doing
  // nothing - the failure mode the shared picker was extracted to prevent.
  await page.route('**/api/import/claude-design', async (route) => {
    await route.fulfill({ status: 400, json: { error: 'not a claude design export' } });
  });

  const importRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/import/claude-design' && request.method() === 'POST';
  });
  const importResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/import/claude-design' && response.request().method() === 'POST';
  });
  const fileChooserPromise = page.waitForEvent('filechooser');
  const starter = page.getByTestId('new-project-import-claude-zip');
  await expect(starter).toBeVisible();
  await starter.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'design.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('PK\u0003\u0004 not really a zip'),
  });
  const [importRequest, importResponse] = await Promise.all([
    importRequestPromise,
    importResponsePromise,
  ]);
  expect(importRequest.postData() ?? '').toContain('design.zip');
  expect(importResponse.status()).toBe(400);

  const alert = page.getByTestId('new-project-modal').locator('.readable-toast');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText('Import failed');
});

test('[P1] the new-session action creates a conversation and navigates to it', async ({ page }) => {
  const project = await createProject(page, `qa-task-2-session-${Date.now()}`);
  const seeded = await fillDefaultConversation(page, project.id);

  await gotoHub(page);

  const row = page.getByTestId(`hub-project-${project.id}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`hub-new-session-${project.id}`).click();

  // Proof through the daemon payload, not the UI: a NEW conversation exists.
  await expect
    .poll(async () => (await listConversations(page, project.id)).length, { timeout: 20_000 })
    .toBe(2);
  const created = (await listConversations(page, project.id)).find(
    (conversation) => conversation.id !== seeded.id,
  );
  expect(created).toBeTruthy();

  // ...and the app navigated to that exact conversation.
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain(created!.id);
  expect(page.url()).toContain(project.id);
});

test('[P1] repeated new-session clicks create exactly one conversation', async ({ page }) => {
  const project = await createProject(page, `qa-task-2-guard-${Date.now()}`);
  await fillDefaultConversation(page, project.id);
  await gotoHub(page);

  const action = page.getByTestId(`hub-new-session-${project.id}`);
  await expect(action).toBeVisible({ timeout: 20_000 });
  await action.click({ clickCount: 3, delay: 10 });

  await expect
    .poll(async () => (await listConversations(page, project.id)).length, { timeout: 20_000 })
    .toBe(2);
  // Give a second create the chance to land before asserting it never did.
  await expect
    .poll(async () => (await listConversations(page, project.id)).length, { timeout: 5_000 })
    .toBe(2);
});

test('[P1] the new-session action reuses an existing empty session', async ({ page }) => {
  const project = await createProject(page, `qa-task-2-reuse-${Date.now()}`);
  const [empty] = await listConversations(page, project.id);
  expect(empty?.messageCount ?? 0).toBe(0);

  await gotoHub(page);
  await expect(page.getByTestId(`hub-project-${project.id}`)).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`hub-new-session-${project.id}`).click();

  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain(empty!.id);
  // No second empty conversation was stacked on top of the one that existed.
  expect(await listConversations(page, project.id)).toHaveLength(1);
});

test('[P1] a completed session row renders its relative last activity', async ({ page }) => {
  const project = await createProject(page, `qa-task-2-meta-${Date.now()}`);
  const created = await page.request.post(`/api/projects/${project.id}/conversations`, {
    data: { title: 'qa-task-2 completed session' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { conversation } = (await created.json()) as { conversation: { id: string } };

  await gotoHub(page);

  const meta = page.getByTestId(`hub-when-${conversation.id}`);
  await expect(meta).toBeVisible({ timeout: 20_000 });
  await expect(meta).toHaveText(
    /^(?:now|(?:[1-9]|[1-5]\d)m|(?:[1-9]|1\d|2[0-3])h|[1-6]d|[1-3]w|(?:[1-9]|1[0-2])\/(?:[1-9]|[12]\d|3[01])\/\d{4})$/,
  );
});

test('[P1] an aborted session read shows a retry, re-issues the request, and never says "no sessions"', async ({
  page,
}) => {
  const project = await createProject(page, `qa-task-2-error-${Date.now()}`);
  const seeded = await page.request.post(`/api/projects/${project.id}/conversations`, {
    data: { title: 'qa-task-2 unreachable session' },
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();

  let attempts = 0;
  let failing = true;
  await page.route('**/api/projects/*/conversations', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    attempts += 1;
    if (failing) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  await gotoHub(page);

  const note = page.getByTestId(`hub-sessions-error-${project.id}`);
  await expect(note).toBeVisible({ timeout: 20_000 });
  await expect(note).toHaveAttribute('data-status', 'unavailable');
  await expect(note).toContainText(/unavailable/i);

  // The tree must not be left in a permanent "loading" state either.
  await expect(page.getByTestId(`hub-sessions-loading-${project.id}`)).toHaveCount(0);

  // The empty-state copy must never be used for a read that FAILED.
  await expect(page.getByTestId('hub-nav')).not.toContainText(/no sessions/i);

  // The aggregate failure is announced as text in a status region.
  const status = page.getByTestId('hub-sessions-status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toContainText(/\d/);

  const before = attempts;
  failing = false;
  await page.getByTestId(`hub-sessions-retry-${project.id}`).click();

  // Retry re-issues the read for THIS project and recovers its rows.
  await expect.poll(() => attempts, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId(`hub-sessions-error-${project.id}`)).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('hub-nav')).toContainText('qa-task-2 unreachable session');
});
