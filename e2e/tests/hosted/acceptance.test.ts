// @vitest-environment node

import { lstat, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { HostedHttpClient } from '@/hosted';
import {
  expectHttpStatus,
  HOSTED_ASSISTANT_MESSAGE_ID as ASSISTANT_MESSAGE_ID,
  jsonMutation,
  jsonRequest,
  readSseUntil,
  readText,
  requiredCursor,
  runIntent,
  startRun,
  waitForProviderOverlap,
  waitForRun,
  type HostedRunStatus as RunStatus,
} from '@/hosted-http';
import { createSmokeSuite } from '@/smoke-suite';

type ProjectResponse = { project: { id: string; name: string } };
type ConversationResponse = { conversation: { id: string; projectId: string } };
type PreviewResponse = { url: string; opaqueOrigin: boolean; iframeSandbox: string };
type ArtifactResponse = { artifactId: string; url: string };
const PRIVATE_ASSISTANT_MESSAGE_ID = 'assistant-private-b';

describe('hosted adversarial acceptance', () => {
  test('proves tenant boundaries and restart recovery', async () => {
    const suite = await createSmokeSuite('hosted-main');

    await suite.with.hosted(async (context) => {
      const a = context.identity('a');
      const b = context.identity('b');
      const secretA = context.provider.credential('a');
      const secretB = context.provider.credential('b');

      const [sessionA, sessionB] = await Promise.all([
        a.json<{ csrfToken: string; providers: Array<{ id: string }> }>('/api/hosted/session'),
        b.json<{ csrfToken: string; providers: Array<{ id: string }> }>('/api/hosted/session'),
      ]);
      expect(sessionA.csrfToken).not.toBe(sessionB.csrfToken);
      expect(sessionA.providers).toContainEqual(expect.objectContaining({ id: 'anthropic' }));

      const [setA, setB] = await Promise.all([
        jsonMutation(a, 'PUT', '/api/hosted/provider', {
          provider: 'anthropic', key: secretA,
        }),
        jsonMutation(b, 'PUT', '/api/hosted/provider', {
          provider: 'anthropic', key: secretB,
        }),
      ]);
      expect(setA).toEqual({ result: 'set', provider: 'anthropic', configured: true });
      expect(setB).toEqual({ result: 'set', provider: 'anthropic', configured: true });
      expect(JSON.stringify([setA, setB])).not.toContain(secretA);
      expect(JSON.stringify([setA, setB])).not.toContain(secretB);
      await Promise.all([
        jsonMutation(a, 'POST', '/api/hosted/provider/test', { provider: 'anthropic' }),
        jsonMutation(b, 'POST', '/api/hosted/provider/test', { provider: 'anthropic' }),
      ]);

      const [projectA, projectB] = await Promise.all([
        jsonMutation<ProjectResponse>(a, 'POST', '/api/projects', {
          title: 'Hosted project A', kind: 'prototype',
        }),
        jsonMutation<ProjectResponse>(b, 'POST', '/api/projects', {
          title: 'Hosted project B', kind: 'prototype',
        }),
      ]);
      expect(projectA.project.id).toBe(projectB.project.id);
      expect(projectA.project.name).toBe('Hosted project A');
      expect(projectB.project.name).toBe('Hosted project B');

      const privateProjectA = await jsonMutation<ProjectResponse>(a, 'POST', '/api/projects', {
        title: 'A-only project', kind: 'prototype',
      });
      await expectHttpStatus(b, `/api/projects/${privateProjectA.project.id}`, 404);
      await expectHttpStatus(b, `/api/projects/${privateProjectA.project.id}/archive`, 404);

      const [conversationA, conversationB] = await Promise.all([
        jsonMutation<ConversationResponse>(
          a,
          'POST',
          `/api/projects/${projectA.project.id}/conversations`,
          { title: 'Hosted conversation A', sessionMode: 'design' },
        ),
        jsonMutation<ConversationResponse>(
          b,
          'POST',
          `/api/projects/${projectB.project.id}/conversations`,
          { title: 'Hosted conversation B', sessionMode: 'design' },
        ),
      ]);
      expect(conversationA.conversation.id).toBe(conversationB.conversation.id);

      await Promise.all([
        jsonMutation(
          a,
          'PUT',
          `/api/projects/${projectA.project.id}/conversations/${conversationA.conversation.id}/messages/${ASSISTANT_MESSAGE_ID}`,
          { role: 'assistant', content: '' },
        ),
        jsonMutation(
          b,
          'PUT',
          `/api/projects/${projectB.project.id}/conversations/${conversationB.conversation.id}/messages/${ASSISTANT_MESSAGE_ID}`,
          { role: 'assistant', content: '' },
        ),
      ]);

      const [runA1, runB1] = await Promise.all([
        startRun(
          a, projectA.project.id, conversationA.conversation.id, 'a-first-turn',
          '[tenant-a-marker] [order:a1] [hold-for-queue] [probe-grant-isolation] A first turn',
        ),
        startRun(
          b, projectB.project.id, conversationB.conversation.id, 'b-first-turn',
          '[tenant-b-marker] [hold-for-cancel] [probe-grant-isolation] B first turn',
        ),
      ]);
      expect(runA1.runId).not.toBe(runB1.runId);
      await waitForProviderOverlap(context.provider.requestSummary);
      const [runA2] = await Promise.all([
        startRun(
          a,
          projectA.project.id,
          conversationA.conversation.id,
          'a-resume-nonce',
          '[tenant-a-marker] [order:a2] A queued follow-up turn',
        ),
        expectHttpStatus(b, `/api/runs/${runB1.runId}/cancel`, 200, { method: 'POST' }),
      ]);
      await Promise.all([
        waitForRun(a, runA1.runId, 'succeeded'),
        waitForRun(b, runB1.runId, 'canceled'),
        waitForRun(a, runA2.runId, 'succeeded'),
      ]);
      expect((await a.json<RunStatus>(`/api/runs/${runA1.runId}`)).status).toBe('succeeded');
      expect((await b.json<RunStatus>(`/api/runs/${runB1.runId}`)).status).toBe('canceled');

      const firstEvents = await readText(a, `/api/runs/${runA1.runId}/events`);
      expect(firstEvents).toContain('event: start');
      expect(firstEvents).toContain('event: agent');
      expect(firstEvents).toContain('event: end');
      const firstCursor = requiredCursor(firstEvents);
      const replay = await readText(a, `/api/runs/${runA1.runId}/events`, {
        headers: { 'Last-Event-ID': firstCursor },
      });
      expect(replay).toContain('event: end');
      expect(replay).not.toContain(`id: ${firstCursor}\n`);

      const heartbeat = await readSseUntil(
        a,
        `/api/projects/${projectA.project.id}/events`,
        /: keepalive/u,
      );
      expect(heartbeat).toContain(': keepalive');

      const maliciousHtml = '<!doctype html><script>top.location="/api/hosted/provider"</script><h1>A</h1>';
      await Promise.all([
        jsonMutation(a, 'POST', `/api/projects/${projectA.project.id}/files`, {
          name: 'index.html', content: maliciousHtml,
        }),
        jsonMutation(b, 'POST', `/api/projects/${projectB.project.id}/files`, {
          name: 'index.html', content: '<!doctype html><h1>B</h1>',
        }),
      ]);
      expect(await readText(a, `/api/projects/${projectA.project.id}/files/index.html`)).toContain('<h1>A</h1>');
      expect(await readText(b, `/api/projects/${projectB.project.id}/files/index.html`)).toContain('<h1>B</h1>');

      const traversal = await a.request(`/api/projects/${projectA.project.id}/files`, jsonRequest('POST', {
        name: '../escape.html', content: 'escape',
      }));
      expect(traversal.status).toBe(400);
      await traversal.arrayBuffer();
      await expectHttpStatus(a, '/api/app-config', 404);

      const forgedOwner = await a.request('/api/projects', jsonRequest('POST', {
        title: 'forged', userKey: 'hosted-acceptance-user-b',
      }));
      expect(forgedOwner.ok).toBe(false);
      await forgedOwner.arrayBuffer();

      const previewA = await preview(a, projectA.project.id);
      const previewB = await preview(b, projectB.project.id);
      const copiedPreview = await fetch(new URL(previewA.body.url, context.daemonUrl), {
        headers: { cookie: previewB.cookie },
      });
      expect(copiedPreview.status).toBe(404);
      await copiedPreview.arrayBuffer();
      const ownedPreview = await fetch(new URL(previewA.body.url, context.daemonUrl), {
        headers: { cookie: previewA.cookie },
      });
      expect(ownedPreview.status).toBe(200);
      expect(ownedPreview.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(ownedPreview.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(await ownedPreview.text()).toBe(maliciousHtml);
      expect(previewA.body).toMatchObject({ opaqueOrigin: true, iframeSandbox: 'allow-scripts' });

      const archive = await expectHttpStatus(a, `/api/projects/${projectA.project.id}/archive`, 200);
      expect(archive.headers.get('content-type')).toContain('application/zip');
      expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(100);

      const artifact = await jsonMutation<ArtifactResponse>(a, 'POST', '/api/artifacts/save', {
        identifier: 'hosted-main', html: '<!doctype html><h1>artifact A</h1>',
      });
      await expectHttpStatus(b, `/api/artifacts/${artifact.artifactId}/download`, 404);
      const artifactDownload = await expectHttpStatus(
        a,
        `/api/artifacts/${artifact.artifactId}/download`,
        200,
      );
      expect(artifactDownload.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await artifactDownload.text()).toContain('artifact A');

      const [projectRootA, projectRootB] = await Promise.all([
        hostedProjectRoot(context.runtimeRoot, 'hosted-acceptance-user-a', projectA.project.id),
        hostedProjectRoot(context.runtimeRoot, 'hosted-acceptance-user-b', projectB.project.id),
      ]);
      const foreignLink = join(projectRootA, 'foreign-link');
      await symlink(projectRootB, foreignLink, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        const linkedRead = await a.request(
          `/api/projects/${projectA.project.id}/files/foreign-link/index.html`,
        );
        expect([400, 404, 503]).toContain(linkedRead.status);
        await linkedRead.arrayBuffer();
        const linkedWrite = await a.request(
          `/api/projects/${projectA.project.id}/files`,
          jsonRequest('POST', { name: 'foreign-link/escape.html', content: 'escape' }),
        );
        expect([400, 404, 503]).toContain(linkedWrite.status);
        await linkedWrite.arrayBuffer();
        const linkedPreview = await a.request(
          `/api/projects/${projectA.project.id}/preview-url`,
          jsonRequest('POST', { file: 'foreign-link/index.html' }),
        );
        expect([400, 404, 503]).toContain(linkedPreview.status);
        await linkedPreview.arrayBuffer();
        expect(await readText(b, `/api/projects/${projectB.project.id}/files/index.html`))
          .toContain('<h1>B</h1>');
      } finally {
        await unlink(foreignLink);
      }

      await context.restart('graceful');
      expect((await a.json<ProjectResponse>(`/api/projects/${projectA.project.id}`)).project.name)
        .toBe('Hosted project A');
      expect(await readText(a, `/api/projects/${projectA.project.id}/files/index.html`)).toBe(maliciousHtml);
      expect(await a.json<{ configured: boolean; provider: null }>('/api/hosted/provider'))
        .toEqual({ configured: false, provider: null });
      await waitForRun(a, runA2.runId, 'succeeded');

      const staleReplay = await readText(a, `/api/runs/${runA1.runId}/events`, {
        headers: { 'Last-Event-ID': firstCursor },
      });
      expect(staleReplay).toContain('event: resync');
      expect(staleReplay).toContain('generation-expired');

      await Promise.all([
        jsonMutation(a, 'PUT', '/api/hosted/provider', {
          provider: 'anthropic', key: secretA,
        }),
        jsonMutation(b, 'PUT', '/api/hosted/provider', {
          provider: 'anthropic', key: secretB,
        }),
      ]);
      const resumedB = await startRun(
        b,
        projectB.project.id,
        conversationB.conversation.id,
        'b-post-restart-resume',
        '[tenant-b-marker] B follow-up after snapshot restore',
      );
      await expectForeignRunBoundary(a, resumedB.runId, '[tenant-b-marker]');
      await waitForRun(b, resumedB.runId, 'succeeded');

      const privateConversationB = await jsonMutation<ConversationResponse>(
        b,
        'POST',
        `/api/projects/${projectB.project.id}/conversations`,
        { title: 'B private session source', sessionMode: 'design' },
      );
      await jsonMutation(
        b,
        'PUT',
        `/api/projects/${projectB.project.id}/conversations/${privateConversationB.conversation.id}/messages/${PRIVATE_ASSISTANT_MESSAGE_ID}`,
        { role: 'assistant', content: '' },
      );
      const privateRunB = await startRun(
        b,
        projectB.project.id,
        privateConversationB.conversation.id,
        'b-private-session-source',
        '[tenant-b-marker] B private session source',
        PRIVATE_ASSISTANT_MESSAGE_ID,
      );
      await waitForRun(b, privateRunB.runId, 'succeeded');
      const copiedSession = await a.request(
        `/api/projects/${projectA.project.id}/conversations`,
        jsonRequest('POST', {
          title: 'Copied B session',
          seedFromConversationId: privateConversationB.conversation.id,
          forkAfterMessageId: PRIVATE_ASSISTANT_MESSAGE_ID,
        }),
      );
      expect(copiedSession.status).toBe(404);
      await copiedSession.arrayBuffer();
      const privateResumeB = await startRun(
        b,
        projectB.project.id,
        privateConversationB.conversation.id,
        'b-private-session-resume',
        '[tenant-b-marker] B private session resume',
        PRIVATE_ASSISTANT_MESSAGE_ID,
      );
      await waitForRun(b, privateResumeB.runId, 'succeeded');

      const resumed = await startRun(
        a,
        projectA.project.id,
        conversationA.conversation.id,
        'a-post-restart-resume',
        '[tenant-a-marker] A follow-up after snapshot restore',
      );
      await waitForRun(a, resumed.runId, 'succeeded');

      const forgedSession = await a.request('/api/runs', jsonRequest('POST', {
        ...runIntent(projectA.project.id, conversationA.conversation.id, 'forged-session', 'forged'),
        sessionReference: 'copied-from-user-b',
      }));
      expect(forgedSession.status).toBe(400);
      await forgedSession.arrayBuffer();

      const canceled = await startRun(
        a,
        projectA.project.id,
        conversationA.conversation.id,
        'a-cancel-run',
        '[tenant-a-marker] A turn canceled during streaming',
      );
      await readSseUntil(a, `/api/runs/${canceled.runId}/events`, /event: start/u);
      await expectForeignRunBoundary(b, canceled.runId, '[tenant-a-marker]');
      await expectHttpStatus(a, `/api/runs/${canceled.runId}/cancel`, 200, { method: 'POST' });
      await waitForRun(a, canceled.runId, 'canceled');
      expect(await a.json<{ configured: boolean; provider: 'anthropic' }>('/api/hosted/provider'))
        .toEqual({ configured: true, provider: 'anthropic' });

      const interrupted = await startRun(
        a,
        projectA.project.id,
        conversationA.conversation.id,
        'a-crash-run',
        '[tenant-a-marker] A turn interrupted by process-tree crash',
      );
      const activeEvents = await readSseUntil(
        a,
        `/api/runs/${interrupted.runId}/events`,
        /event: start/u,
      );
      const activeCursor = requiredCursor(activeEvents);
      await context.restart('crash');

      const recovered = await waitForRun(a, interrupted.runId, 'interrupted');
      expect(recovered.resumable).toBe(true);
      expect(await a.json<{ configured: boolean; provider: null }>('/api/hosted/provider'))
        .toEqual({ configured: false, provider: null });
      const crashReplay = await readText(a, `/api/runs/${interrupted.runId}/events`, {
        headers: { 'Last-Event-ID': activeCursor },
      });
      expect(crashReplay).toContain('event: resync');

      const providerSummary = context.provider.requestSummary();
      const markedProviderRequests = providerSummary.requests
        .filter((request) => request.promptMarker !== 'unknown');
      expect(providerSummary.count).toBeGreaterThanOrEqual(6);
      expect(providerSummary.requests.every((request) => request.path === '/v1/messages')).toBe(true);
      expect(markedProviderRequests.length).toBeGreaterThanOrEqual(4);
      expect(markedProviderRequests.every(
        (request) => request.promptMarker === request.credential,
      )).toBe(true);
      expect(providerSummary.maxConcurrentMarkedRequests).toBeGreaterThanOrEqual(2);
      expect(providerSummary.maxConcurrentMarkedRequestsByCredential).toEqual({ a: 1, b: 1 });
      expect(providerSummary.requests
        .filter((request) => request.credential === 'a' && request.turnMarker != null)
        .map((request) => request.turnMarker)).toEqual(['a1', 'a2']);
      expect(providerSummary.requests).toContainEqual(expect.objectContaining({
        credential: 'a', stream: true,
      }));
      expect(providerSummary.requests).toContainEqual(expect.objectContaining({
        credential: 'b', stream: true,
      }));
      expect(JSON.stringify(providerSummary)).not.toContain(secretA);
      expect(JSON.stringify(providerSummary)).not.toContain(secretB);

      await suite.report.json('summary.json', {
        collisions: {
          conversationId: conversationA.conversation.id,
          projectId: projectA.project.id,
          runId: runA1.runId,
        },
        namespace: suite.namespace,
        provider: providerSummary,
        recovery: {
          gracefulRun: resumed.runId,
          gracefulRunB: resumedB.runId,
          interruptedRun: interrupted.runId,
          interruptedStatus: recovered.status,
        },
        runtime: {
          daemonUrl: context.daemonUrl,
          runtimeRoot: context.runtimeRoot,
          webUrl: context.webUrl,
        },
        unproven: [
          'Databricks Apps ingress and identity',
          'Unity Catalog persistence',
          'production Gateway connectivity',
          'Databricks autoscaling and capacity',
        ],
      });
    });
  }, 600_000);
});

async function expectForeignRunBoundary(
  client: HostedHttpClient,
  runId: string,
  privateMarker: string,
): Promise<void> {
  await (await expectHttpStatus(client, `/api/runs/${runId}`, 404)).arrayBuffer();
  const events = await expectHttpStatus(client, `/api/runs/${runId}/events`, 404, {
    headers: { accept: 'text/event-stream' },
  });
  expect(await events.text()).not.toContain(privateMarker);
  await (await expectHttpStatus(client, `/api/runs/${runId}/cancel`, 404, {
    method: 'POST',
  })).arrayBuffer();
}

async function preview(
  client: HostedHttpClient,
  projectId: string,
): Promise<{ body: PreviewResponse; cookie: string }> {
  const response = await client.request(
    `/api/projects/${projectId}/preview-url`,
    jsonRequest('POST', { file: 'index.html' }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toEqual(expect.any(String));
  return {
    body: await response.json() as PreviewResponse,
    cookie: setCookie!.split(';', 1)[0]!,
  };
}

async function hostedProjectRoot(
  runtimeRoot: string,
  userKey: string,
  projectId: string,
): Promise<string> {
  const liveRoot = join(runtimeRoot, 'live');
  for (const storageKey of await readdir(liveRoot)) {
    const storageRoot = join(liveRoot, storageKey);
    let marker: { userKey?: unknown };
    try {
      marker = JSON.parse(await readFile(join(storageRoot, '.identity.json'), 'utf8')) as {
        userKey?: unknown;
      };
    } catch {
      continue;
    }
    if (marker.userKey !== userKey) continue;
    for (const generation of await readdir(storageRoot)) {
      if (!generation.startsWith('generation-')) continue;
      const projectRoot = join(storageRoot, generation, 'projects', projectId);
      try {
        if ((await lstat(projectRoot)).isDirectory()) return projectRoot;
      } catch {
        // This generation does not own the project.
      }
    }
  }
  throw new Error(`hosted project root was not found for ${userKey}`);
}
