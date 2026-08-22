import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startHostedServer,
  type HostedTestComposition,
} from '../src/hosted-server.js';

const PUBLIC_ORIGIN = 'https://hosted.readable-studio.test';
const USER_A = 'pr07-user-a';
const USER_B = 'pr07-user-b';

type StartedServer = Awaited<ReturnType<typeof startHostedServer>>;

type Project = { id: string; name: string };
type Conversation = { id: string; projectId: string; title: string | null };
type SseFrame = { data?: unknown; event?: string; id?: string; raw: string };
type SseStream = {
  buffer: string;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  response: Response;
};

const startedServers: StartedServer[] = [];
const runtimeRoots: string[] = [];
const openStreams: SseStream[] = [];

afterEach(async () => {
  for (const stream of openStreams.splice(0)) closeSse(stream);
  await Promise.all(startedServers.splice(0).map((started) => started.shutdown()));
  await Promise.all(runtimeRoots.splice(0).map(removeRuntimeRoot));
});

describe('hosted PR07 HTTP surface', () => {
  it('serves immutable catalogues without creating a user runtime', async () => {
    const started = await start();
    await expectSuccess(fetchJson(started, USER_A, '/api/skills'));
    await expect(readdir(runtimeRoots.at(-1)!)).resolves.toEqual([]);
  });

  it('closes the HTTP listener even when runtime shutdown fails', async () => {
    const started = await start({
      shutdownRegistry: async () => { throw new Error('injected registry shutdown failure'); },
    });
    startedServers.splice(startedServers.indexOf(started), 1);

    await expect(started.shutdown()).rejects.toThrow('injected registry shutdown failure');
    expect(started.server.listening).toBe(false);
    await expect(fetch(`${started.url}/api/health`)).rejects.toThrow();
  });

  it('holds body capacity through request completion and releases it after timeout', async () => {
    const started = await start({ bodyReadTimeoutMs: 500 });
    const csrf = await getCsrfToken(started, USER_A);
    const first = openPartialJson(started, USER_A, csrf, '/api/projects');
    const second = openPartialJson(started, USER_A, csrf, '/api/projects');
    await Promise.all([first.flushed, second.flushed]);
    await delay(20);

    await expectError(
      mutate(started, USER_A, csrf, 'POST', '/api/projects', { title: 'over capacity' }),
      429,
      'HOSTED_OVERLOADED',
    );
    await expectRawError(first.response, 408, 'BAD_REQUEST');
    await expectRawError(second.response, 408, 'BAD_REQUEST');
    await expectSuccess(mutate(
      started,
      USER_A,
      csrf,
      'POST',
      '/api/projects',
      { title: 'capacity released' },
    ));
  });

  it('does not report a committed conversation as failed when event capacity is exhausted', async () => {
    const started = await start({ eventBudgetLimits: { maxBytes: 1 } });
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'event pressure');

    const conversation = await createConversation(
      started,
      USER_A,
      csrf,
      project.id,
      'committed once',
    );
    expect(conversation.title).toBe('committed once');
    const listed = await json<{ conversations: Conversation[] }>(fetchJson(
      started,
      USER_A,
      `/api/projects/${project.id}/conversations`,
    ));
    expect(listed.conversations).toEqual([expect.objectContaining({ id: conversation.id })]);
  });

  it('isolates project, conversation, message, comment, tab, and checkpoint metadata by identity', async () => {
    const started = await start();
    const [csrfA, csrfB] = await Promise.all([
      getCsrfToken(started, USER_A),
      getCsrfToken(started, USER_B),
    ]);
    const projectA = await createProject(started, USER_A, csrfA, 'A private project');
    const projectB = await createProject(started, USER_B, csrfB, 'B private project');

    expect(projectA.id).toBe('same-project-1');
    expect(projectB.id).toBe(projectA.id);
    expect(await projectIds(started, USER_A)).toEqual([projectA.id]);
    expect(await projectIds(started, USER_B)).toEqual([projectB.id]);
    expect(await getProject(started, USER_A, projectA.id)).toMatchObject({
      id: projectA.id,
      name: 'A private project',
    });
    expect(await getProject(started, USER_B, projectA.id)).toMatchObject({
      id: projectA.id,
      name: 'B private project',
    });

    const patchedA = await json<{ project: Project }>(
      mutate(started, USER_A, csrfA, 'PATCH', `/api/projects/${projectA.id}`, {
        title: 'A only',
      }),
    );
    const patchedB = await json<{ project: Project }>(
      mutate(started, USER_B, csrfB, 'PATCH', `/api/projects/${projectB.id}`, {
        title: 'B only',
      }),
    );
    expect(patchedA.project).toMatchObject({ id: projectA.id, name: 'A only' });
    expect(patchedB.project).toMatchObject({ id: projectA.id, name: 'B only' });
    expect(await getProject(started, USER_A, projectA.id)).toMatchObject({ name: 'A only' });
    expect(await getProject(started, USER_B, projectA.id)).toMatchObject({ name: 'B only' });

    const conversationA = await createConversation(
      started,
      USER_A,
      csrfA,
      projectA.id,
      'A private conversation',
    );
    const conversationB = await createConversation(
      started,
      USER_B,
      csrfB,
      projectB.id,
      'B private conversation',
    );
    expect(conversationA.id).toBe('same-conversation-1');
    expect(conversationB.id).toBe(conversationA.id);

    const patchedConversationA = await json<{ conversation: Conversation }>(
      mutate(
        started,
        USER_A,
        csrfA,
        'PATCH',
        `/api/projects/${projectA.id}/conversations/${conversationA.id}`,
        { title: 'A renamed conversation' },
      ),
    );
    const patchedConversationB = await json<{ conversation: Conversation }>(
      mutate(
        started,
        USER_B,
        csrfB,
        'PATCH',
        `/api/projects/${projectB.id}/conversations/${conversationB.id}`,
        { title: 'B renamed conversation' },
      ),
    );
    expect(patchedConversationA.conversation).toMatchObject({
      id: conversationA.id,
      projectId: projectA.id,
      title: 'A renamed conversation',
    });
    expect(patchedConversationB.conversation).toMatchObject({
      id: conversationA.id,
      projectId: projectA.id,
      title: 'B renamed conversation',
    });

    const messageId = 'same-message-id';
    const messageA = await json<{ message: { content: string; id: string; role: string } }>(
      mutate(
        started,
        USER_A,
        csrfA,
        'PUT',
        `/api/projects/${projectA.id}/conversations/${conversationA.id}/messages/${messageId}`,
        { role: 'user', content: 'hello from A' },
      ),
    );
    const messageB = await json<{ message: { content: string; id: string; role: string } }>(
      mutate(
        started,
        USER_B,
        csrfB,
        'PUT',
        `/api/projects/${projectB.id}/conversations/${conversationB.id}/messages/${messageId}`,
        { role: 'user', content: 'hello from B' },
      ),
    );
    expect(messageA.message).toMatchObject({
      id: messageId,
      role: 'user',
      content: 'hello from A',
    });
    expect(messageB.message).toMatchObject({
      id: messageId,
      role: 'user',
      content: 'hello from B',
    });
    const messagesA = await json<{ messages: Array<{ content: string; id: string }> }>(fetchJson(
      started,
      USER_A,
      `/api/projects/${projectA.id}/conversations/${conversationA.id}/messages`,
    ));
    const messagesB = await json<{ messages: Array<{ content: string; id: string }> }>(fetchJson(
      started,
      USER_B,
      `/api/projects/${projectB.id}/conversations/${conversationB.id}/messages`,
    ));
    expect(messagesA.messages).toEqual([expect.objectContaining({ id: messageId, content: 'hello from A' })]);
    expect(messagesB.messages).toEqual([expect.objectContaining({ id: messageId, content: 'hello from B' })]);

    const commentA = await json<{ comment: { id: string; note: string } }>(
      mutate(
        started,
        USER_A,
        csrfA,
        'POST',
        `/api/projects/${projectA.id}/conversations/${conversationA.id}/comments`,
        commentBody('A note'),
      ),
    );
    const commentB = await json<{ comment: { id: string; note: string } }>(
      mutate(
        started,
        USER_B,
        csrfB,
        'POST',
        `/api/projects/${projectB.id}/conversations/${conversationB.id}/comments`,
        commentBody('B note'),
      ),
    );
    expect(commentA.comment).toMatchObject({ id: expect.any(String), note: 'A note' });
    expect(commentB.comment).toMatchObject({ id: expect.any(String), note: 'B note' });
    const commentsA = await json<{ comments: Array<{ note: string }> }>(fetchJson(
      started,
      USER_A,
      `/api/projects/${projectA.id}/conversations/${conversationA.id}/comments`,
    ));
    const commentsB = await json<{ comments: Array<{ note: string }> }>(fetchJson(
      started,
      USER_B,
      `/api/projects/${projectB.id}/conversations/${conversationB.id}/comments`,
    ));
    expect(commentsA.comments).toEqual([expect.objectContaining({ note: 'A note' })]);
    expect(commentsB.comments).toEqual([expect.objectContaining({ note: 'B note' })]);

    const tabsA = await json<{ active: string | null; browserTabs: unknown[]; tabs: string[] }>(
      mutate(started, USER_A, csrfA, 'PUT', `/api/projects/${projectA.id}/tabs`, {
        tabs: ['a.html'],
        active: 'a.html',
        browserTabs: [],
      }),
    );
    const tabsB = await json<{ active: string | null; browserTabs: unknown[]; tabs: string[] }>(
      mutate(started, USER_B, csrfB, 'PUT', `/api/projects/${projectB.id}/tabs`, {
        tabs: ['b.html'],
        active: 'b.html',
        browserTabs: [],
      }),
    );
    expect(tabsA).toMatchObject({ tabs: ['a.html'], active: 'a.html', browserTabs: [] });
    expect(tabsB).toMatchObject({ tabs: ['b.html'], active: 'b.html', browserTabs: [] });
    expect(await json(fetchJson(started, USER_A, `/api/projects/${projectA.id}/tabs`)))
      .toMatchObject({ tabs: ['a.html'], active: 'a.html' });
    expect(await json(fetchJson(started, USER_B, `/api/projects/${projectB.id}/tabs`)))
      .toMatchObject({ tabs: ['b.html'], active: 'b.html' });

    const checkpointsA = await json<{ checkpoints: unknown[] }>(fetchJson(
      started,
      USER_A,
      `/api/projects/${projectA.id}/checkpoints?conversationId=${conversationA.id}`,
    ));
    const checkpointsB = await json<{ checkpoints: unknown[] }>(fetchJson(
      started,
      USER_B,
      `/api/projects/${projectB.id}/checkpoints?conversationId=${conversationB.id}`,
    ));
    expect(checkpointsA.checkpoints).toEqual([]);
    expect(checkpointsB.checkpoints).toEqual([]);
    await expectOwnedNotFound(fetchJson(
      started,
      USER_A,
      `/api/projects/${projectA.id}/checkpoints/missing-checkpoint`,
    ));
    await expectOwnedNotFound(fetchJson(
      started,
      USER_A,
      `/api/projects/${projectA.id}/checkpoints/missing-checkpoint/diff?base=current`,
    ));

    await expectSuccess(mutate(
      started,
      USER_B,
      csrfB,
      'DELETE',
      `/api/projects/${projectB.id}/conversations/${conversationB.id}`,
    ));
    await expectOwnedNotFound(fetchJson(
      started,
      USER_B,
      `/api/projects/${projectB.id}/conversations/${conversationB.id}/messages`,
    ));
    const survivingConversations = await json<{ conversations: Conversation[] }>(fetchJson(
      started,
      USER_A,
      `/api/projects/${projectA.id}/conversations`,
    ));
    expect(survivingConversations.conversations).toEqual([
      expect.objectContaining({ id: conversationA.id, title: 'A renamed conversation' }),
    ]);

    await expectSuccess(mutate(started, USER_B, csrfB, 'DELETE', `/api/projects/${projectB.id}`));
    await expectOwnedNotFound(fetchJson(started, USER_B, `/api/projects/${projectB.id}`));
    await expectOwnedNotFound(mutate(
      started,
      USER_B,
      csrfB,
      'PATCH',
      `/api/projects/${projectB.id}`,
      { title: 'cannot reach A' },
    ));
    expect(await getProject(started, USER_A, projectA.id)).toMatchObject({ name: 'A only' });

    await expectSuccess(mutate(started, USER_A, csrfA, 'DELETE', `/api/projects/${projectA.id}`));
    expect(await projectIds(started, USER_A)).toEqual([]);
    expect(await projectIds(started, USER_B)).toEqual([]);
  });

  it('rejects owner, unknown, root, plugin, template, local-config, and tool fields before dispatch', async () => {
    const started = await start();
    const csrf = await getCsrfToken(started, USER_A);

    for (const [label, path, body, code] of [
      ['owner', '/api/projects', { title: 'bad', ownerId: USER_B }, 'HOSTED_OWNER_FIELD_FORBIDDEN'],
      ['unknown', '/api/projects', { title: 'bad', surprise: true }, 'BAD_REQUEST'],
      ['client id', '/api/projects', { id: 'chosen-by-client', title: 'bad' }, 'BAD_REQUEST'],
      ['external root', '/api/projects', { title: 'bad', baseDir: 'C:\\outside' }, 'BAD_REQUEST'],
      ['plugin', '/api/projects', { title: 'bad', pluginId: 'plugin-a' }, 'BAD_REQUEST'],
      ['template', '/api/projects', { title: 'bad', templateId: 'template-a' }, 'BAD_REQUEST'],
      ['local config', '/api/runs', {
        ...runIntent('missing-project', 'missing-conversation', 'missing-message', 'local-config'),
        systemPrompt: 'client authority',
      }, 'BAD_REQUEST'],
      ['tool bundle', '/api/runs', {
        ...runIntent('missing-project', 'missing-conversation', 'missing-message', 'tool-bundle'),
        toolBundle: { mcpServers: [] },
      }, 'BAD_REQUEST'],
    ] as const) {
      await expectError(
        mutate(started, USER_A, csrf, 'POST', path, body),
        400,
        code,
        label,
      );
    }

    await expectError(
      fetchJson(started, USER_A, '/api/projects?ownerId=attacker'),
      400,
      'HOSTED_OWNER_FIELD_FORBIDDEN',
    );
    await expectError(
      fetch(`${started.url}/api/projects`, {
        headers: { ...auth(USER_A), 'x-user-key': 'attacker' },
      }),
      400,
      'HOSTED_OWNER_FIELD_FORBIDDEN',
    );
  });

  it('activates run, chat, status, event, cancel, feedback, AGUI, and GenUI shapes without ambient credentials', async () => {
    const started = await start();
    const [csrfA, csrfB] = await Promise.all([
      getCsrfToken(started, USER_A),
      getCsrfToken(started, USER_B),
    ]);
    const project = await createProject(started, USER_A, csrfA, 'Run owner');
    const conversation = await createConversation(started, USER_A, csrfA, project.id, 'Run conversation');
    const assistantMessageId = 'assistant-message-a';
    await expectSuccess(mutate(
      started,
      USER_A,
      csrfA,
      'PUT',
      `/api/projects/${project.id}/conversations/${conversation.id}/messages/${assistantMessageId}`,
      { role: 'assistant', content: '' },
    ));
    const intent = runIntent(project.id, conversation.id, assistantMessageId, 'missing-provider');

    expect(await json<{ runs: unknown[] }>(fetchJson(started, USER_A, '/api/runs')))
      .toEqual({ runs: [] });
    await expectError(
      mutate(started, USER_A, csrfA, 'POST', '/api/runs', intent),
      409,
      'HOSTED_PROVIDER_MISSING',
    );
    await expectError(
      mutate(started, USER_A, csrfA, 'POST', '/api/chat', {
        ...intent,
        clientRequestId: 'chat-missing-provider',
      }),
      409,
      'HOSTED_PROVIDER_MISSING',
    );

    await expectOwnedNotFound(fetchJson(started, USER_B, `/api/runs?projectId=${project.id}`));
    await expectOwnedNotFound(mutate(started, USER_B, csrfB, 'POST', '/api/runs', {
      ...intent,
      clientRequestId: 'copied-a-session',
    }));

    for (const [method, path, body] of [
      ['GET', '/api/runs/missing-run', undefined],
      ['GET', '/api/runs/missing-run/events', undefined],
      ['POST', '/api/runs/missing-run/cancel', undefined],
      ['POST', '/api/runs/missing-run/feedback', {
        projectId: project.id,
        conversationId: conversation.id,
        assistantMessageId,
        rating: 'positive',
        reasonCodes: ['matched_request'],
        hasCustomReason: false,
        customReason: '',
      }],
      ['GET', '/api/runs/missing-run/agui', undefined],
      ['GET', '/api/runs/missing-run/genui', undefined],
      ['GET', '/api/runs/missing-run/genui/missing-surface', undefined],
      ['POST', '/api/runs/missing-run/genui/missing-surface/respond', { value: 'answer' }],
    ] as const) {
      const response = method === 'GET'
        ? fetchJson(started, USER_A, path)
        : mutate(started, USER_A, csrfA, method, path, body);
      await expectOwnedNotFound(response);
    }

    expect(await json(fetchJson(started, USER_A, `/api/projects/${project.id}/genui`)))
      .toEqual({ projectId: project.id, surfaces: [] });
    await expectOwnedNotFound(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      `/api/projects/${project.id}/genui/missing-surface/revoke`,
    ));
    await expectError(
      fetchJson(started, USER_A, '/api/runs?status=not-a-status'),
      400,
      'BAD_REQUEST',
    );
  });

  it('replays an injected successful run only to its owner', async () => {
    const runId = 'same-run-id';
    const surfaceId = 'same-surface-id';
    const revokeSurfaceId = 'same-revoke-surface-id';
    const started = await start({
      createRunId: () => runId,
      async startTurn(input) {
        input.send('agent', { delta: 'A private result' });
        input.send('genui', {
          kind: 'ui.surface_requested',
          surfaceId,
          surfaceKind: 'confirmation',
          payload: { persist: 'project', prompt: 'Approve?' },
        });
        input.send('genui', {
          kind: 'ui.surface_requested',
          surfaceId: revokeSurfaceId,
          surfaceKind: 'confirmation',
          payload: { persist: 'project', prompt: 'Revoke?' },
        });
        const sessionReference = await writeTestSession(input);
        return {
          sessionReference,
          value: { status: 'succeeded', exitCode: 0, signal: null },
        };
      },
    });
    const [csrfA, csrfB] = await Promise.all([
      getCsrfToken(started, USER_A),
      getCsrfToken(started, USER_B),
    ]);
    const projectA = await createProject(started, USER_A, csrfA, 'A run project');
    const projectB = await createProject(started, USER_B, csrfB, 'B colliding project');
    const conversationA = await createConversation(
      started, USER_A, csrfA, projectA.id, 'A run conversation',
    );
    const conversationB = await createConversation(
      started, USER_B, csrfB, projectB.id, 'B colliding conversation',
    );
    const assistantMessageId = 'same-assistant-message-id';
    await expectSuccess(mutate(
      started,
      USER_A,
      csrfA,
      'PUT',
      `/api/projects/${projectA.id}/conversations/${conversationA.id}/messages/${assistantMessageId}`,
      { role: 'assistant', content: '' },
    ));
    await expectSuccess(mutate(
      started,
      USER_B,
      csrfB,
      'PUT',
      `/api/projects/${projectB.id}/conversations/${conversationB.id}/messages/${assistantMessageId}`,
      { role: 'assistant', content: '' },
    ));
    await expectSuccess(mutate(started, USER_A, csrfA, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic',
      key: 'test-only-key-a',
    }));

    const accepted = await json<{ runId: string }>(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      '/api/runs',
      runIntent(projectA.id, conversationA.id, assistantMessageId, 'successful-run-a'),
    ));
    expect(accepted.runId).toBe(runId);
    await waitForRunStatus(started, USER_A, runId, 'succeeded');

    const firstReplay = await openSse(started, USER_A, `/api/runs/${runId}/events`);
    const first = await readSseFrame(firstReplay, 5_000);
    expect(first).toMatchObject({
      event: 'start',
      id: expect.any(String),
      data: { agentId: 'pi', projectId: projectA.id, runId },
    });
    closeSse(firstReplay);
    const replay = await openSse(started, USER_A, `/api/runs/${runId}/events`, first.id);
    const replayed = [
      await readSseFrame(replay, 5_000),
      await readSseFrame(replay, 5_000),
    ];
    expect(replayed).toEqual([
      expect.objectContaining({ event: 'agent', data: { type: 'text_delta', delta: 'A private result' } }),
      expect.objectContaining({ event: 'end', data: expect.objectContaining({ status: 'succeeded' }) }),
    ]);
    closeSse(replay);

    expect(await json(fetchJson(started, USER_A, `/api/runs/${runId}/agui`))).toMatchObject({
      events: [
        { kind: 'run.lifecycle', runId, status: 'started' },
        { kind: 'agent.message', runId, text: 'A private result' },
        { kind: 'ui.surface_requested', runId, surfaceId },
        { kind: 'ui.surface_requested', runId, surfaceId: revokeSurfaceId },
        { kind: 'run.lifecycle', runId, status: 'completed' },
      ],
    });
    expect(await json(fetchJson(started, USER_A, `/api/runs/${runId}/genui`))).toMatchObject({
      runId,
      surfaces: [
        { projectId: projectA.id, runId, surfaceId, status: 'pending' },
        { projectId: projectA.id, runId, surfaceId: revokeSurfaceId, status: 'pending' },
      ],
    });

    expect(await json(fetchJson(
      started,
      USER_B,
      `/api/runs?projectId=${projectB.id}&conversationId=${conversationB.id}`,
    ))).toEqual({ runs: [] });
    for (const response of [
      fetchJson(started, USER_B, `/api/runs/${runId}`),
      mutate(started, USER_B, csrfB, 'POST', `/api/runs/${runId}/cancel`),
      fetchJson(started, USER_B, `/api/runs/${runId}/agui`),
      fetchJson(started, USER_B, `/api/runs/${runId}/genui`),
      fetchJson(started, USER_B, `/api/runs/${runId}/genui/${surfaceId}`),
      mutate(
        started,
        USER_B,
        csrfB,
        'POST',
        `/api/runs/${runId}/genui/${surfaceId}/respond`,
        { value: true },
      ),
    ]) await expectOwnedNotFound(response);

    const copiedCursor = await fetch(`${started.url}/api/runs/${runId}/events`, {
      headers: { ...auth(USER_B), accept: 'text/event-stream', 'last-event-id': first.id! },
    });
    const copiedCursorBody = await copiedCursor.text();
    expect(copiedCursor.status, copiedCursorBody).toBe(404);
    expect(copiedCursorBody).not.toContain('A private result');
    expect(await json(fetchJson(started, USER_B, `/api/projects/${projectB.id}/genui`)))
      .toEqual({ projectId: projectB.id, surfaces: [] });
    await expectOwnedNotFound(mutate(
      started,
      USER_B,
      csrfB,
      'POST',
      `/api/projects/${projectB.id}/genui/${surfaceId}/revoke`,
    ));

    expect(await json(fetchJson(started, USER_A, `/api/runs/${runId}/genui/${surfaceId}`)))
      .toMatchObject({ projectId: projectA.id, runId, surfaceId, status: 'pending' });
    const opaqueValue = { owner: 'Design team', userKey: 'display label' };
    expect(await json(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      `/api/runs/${runId}/genui/${surfaceId}/respond`,
      { value: opaqueValue },
    ))).toMatchObject({ ok: true, surface: { status: 'resolved', value: opaqueValue } });
    expect(await json(mutate(
      started,
      USER_A,
      csrfA,
      'POST',
      `/api/projects/${projectA.id}/genui/${revokeSurfaceId}/revoke`,
    ))).toEqual({ ok: true, invalidated: 1 });
    expect(await json(fetchJson(started, USER_A, `/api/runs/${runId}/genui/${revokeSurfaceId}`)))
      .toMatchObject({ projectId: projectA.id, runId, surfaceId: revokeSurfaceId, status: 'invalidated' });
    expect(await json<{ runs: Array<{ id: string; status: string }> }>(fetchJson(
      started,
      USER_A,
      `/api/runs?projectId=${projectA.id}&conversationId=${conversationA.id}`,
    ))).toMatchObject({ runs: [{ id: runId, status: 'succeeded' }] });
  });

  it('streams chat lifecycle events and closes after the terminal event', async () => {
    const runId = 'chat-stream-run';
    const started = await start({
      createRunId: () => runId,
      async startTurn(input) {
        input.send('agent', { delta: 'streamed result' });
        const sessionReference = await writeTestSession(input);
        return {
          sessionReference,
          value: { status: 'succeeded', exitCode: 0, signal: null },
        };
      },
    });
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Chat stream project');
    const conversation = await createConversation(
      started, USER_A, csrf, project.id, 'Chat stream conversation',
    );
    const assistantMessageId = 'chat-stream-message';
    await expectSuccess(mutate(
      started,
      USER_A,
      csrf,
      'PUT',
      `/api/projects/${project.id}/conversations/${conversation.id}/messages/${assistantMessageId}`,
      { role: 'assistant', content: '' },
    ));
    await expectSuccess(mutate(started, USER_A, csrf, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic',
      key: 'test-only-chat-key',
    }));
    const controller = new AbortController();
    const response = await fetch(`${started.url}/api/chat`, {
      method: 'POST',
      headers: {
        ...auth(USER_A),
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-readable-studio-csrf': csrf,
        origin: PUBLIC_ORIGIN,
      },
      body: JSON.stringify(runIntent(
        project.id,
        conversation.id,
        assistantMessageId,
        'chat-stream-request',
      )),
      signal: controller.signal,
    });
    expect(response.status, await bodyOnFailure(response)).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (response.body == null) throw new Error('chat SSE response had no body');
    const stream: SseStream = {
      buffer: '',
      controller,
      reader: response.body.getReader(),
      response,
    };
    openStreams.push(stream);

    const frames = [
      await readSseFrame(stream, 5_000),
      await readSseFrame(stream, 5_000),
      await readSseFrame(stream, 5_000),
    ];
    expect(frames).toEqual([
      expect.objectContaining({ event: 'start', data: expect.objectContaining({ runId }) }),
      expect.objectContaining({ event: 'agent', data: { type: 'text_delta', delta: 'streamed result' } }),
      expect.objectContaining({ event: 'end', data: expect.objectContaining({ status: 'succeeded' }) }),
    ]);
    await expect(stream.reader.read()).resolves.toMatchObject({ done: true });
  });

  it('resumes a second turn and reconciles an active cancellation', async () => {
    let nextRun = 0;
    const seenSessions: Array<string | null | undefined> = [];
    const started = await start({
      createRunId: () => `resume-run-${++nextRun}`,
      startTurn: async (input) => {
        seenSessions.push(input.sessionReference);
        if (input.capabilities.runId === 'resume-run-3') {
          if (input.sessionReference == null) throw new Error('resume session missing');
          const sessionReference = input.sessionReference;
          return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({
            sessionReference,
            value: { status: 'canceled', exitCode: null, signal: null },
          }), { once: true }));
        }
        const sessionReference = await writeTestSession(input);
        return {
          sessionReference,
          value: { status: 'succeeded', exitCode: 0, signal: null },
        };
      },
    });
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Resume project');
    const conversation = await createConversation(
      started, USER_A, csrf, project.id, 'Resume conversation',
    );
    const assistantMessageId = 'resume-assistant-message';
    await expectSuccess(mutate(
      started,
      USER_A,
      csrf,
      'PUT',
      `/api/projects/${project.id}/conversations/${conversation.id}/messages/${assistantMessageId}`,
      { role: 'assistant', content: '' },
    ));
    await expectSuccess(mutate(started, USER_A, csrf, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic',
      key: 'test-only-resume-key',
    }));

    for (const index of [1, 2]) {
      const accepted = await json<{ runId: string }>(mutate(
        started,
        USER_A,
        csrf,
        'POST',
        '/api/runs',
        runIntent(project.id, conversation.id, assistantMessageId, `resume-request-${index}`),
      ));
      await waitForRunStatus(started, USER_A, accepted.runId, 'succeeded');
    }
    expect(seenSessions[0]).toBeNull();
    expect(seenSessions[1]).toEqual(expect.stringMatching(/resume-run-1\.jsonl$/u));

    const active = await json<{ runId: string }>(mutate(
      started,
      USER_A,
      csrf,
      'POST',
      '/api/runs',
      runIntent(project.id, conversation.id, assistantMessageId, 'cancel-request'),
    ));
    await waitForRunStatus(started, USER_A, active.runId, 'running');
    expect(await json(mutate(
      started, USER_A, csrf, 'POST', `/api/runs/${active.runId}/cancel`,
    ))).toEqual({ ok: true });
    await waitForRunStatus(started, USER_A, active.runId, 'canceled');
  });

  it('serves a run-bound design-system read before parsing copied-token input', async () => {
    const carrierToken = `odpi_${'a'.repeat(43)}`;
    let copiedStatus = 0;
    let readContent = '';
    const started = await start({
      createRunId: () => 'design-tool-run',
      async startTurn(input, dependencies) {
        const tool = dependencies.designSystemTool;
        const designSystemId = input.capabilities.designSystemId;
        if (tool == null || designSystemId == null) throw new Error('design tool missing');
        const grant = await tool.mintGrant({
          userKey: input.capabilities.userKey,
          runId: input.capabilities.runId,
          projectId: input.capabilities.projectId,
          generation: input.capabilities.generation,
          designSystemId,
          carrierToken,
        });
        try {
          const copied = await fetch(tool.readUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${grant.token}`,
              'content-type': 'application/json',
              'x-readable-studio-tool-token': `odpi_${'b'.repeat(43)}`,
            },
            body: 'not-json',
          });
          copiedStatus = copied.status;
          await copied.arrayBuffer();
          const response = await fetch(tool.readUrl, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${grant.token}`,
              'content-type': 'application/json',
              'x-readable-studio-tool-token': carrierToken,
            },
            body: JSON.stringify({ designSystemId, path: 'DESIGN.md' }),
          });
          const body = await response.json() as { content?: unknown };
          if (!response.ok || typeof body.content !== 'string') {
            throw new Error('design tool read failed');
          }
          readContent = body.content;
        } finally {
          await grant.revoke();
        }
        const sessionReference = await writeTestSession(input);
        return {
          sessionReference,
          value: { status: 'succeeded', exitCode: 0, signal: null },
        };
      },
    });
    const csrf = await getCsrfToken(started, USER_A);
    const systems = await json<{ designSystems: Array<{ id: string }> }>(
      fetchJson(started, USER_A, '/api/design-systems'),
    );
    const designSystemId = systems.designSystems[0]!.id;
    const project = await createProject(started, USER_A, csrf, 'Design tool project');
    const conversation = await createConversation(
      started, USER_A, csrf, project.id, 'Design tool conversation',
    );
    const assistantMessageId = 'design-tool-message';
    await expectSuccess(mutate(
      started,
      USER_A,
      csrf,
      'PUT',
      `/api/projects/${project.id}/conversations/${conversation.id}/messages/${assistantMessageId}`,
      { role: 'assistant', content: '' },
    ));
    await expectSuccess(mutate(started, USER_A, csrf, 'PUT', '/api/hosted/provider', {
      provider: 'anthropic',
      key: 'test-only-design-tool-key',
    }));
    const intent = runIntent(project.id, conversation.id, assistantMessageId, 'design-tool-request');
    intent.designSystemId = designSystemId;
    const accepted = await json<{ runId: string }>(mutate(
      started, USER_A, csrf, 'POST', '/api/runs', intent,
    ));

    await waitForRunStatus(started, USER_A, accepted.runId, 'succeeded');
    expect(copiedStatus).toBe(403);
    expect(readContent).toContain('#');
  });

  it('serves fixed catalogues and denies the browser ambient access to the tool broker', async () => {
    const started = await start();
    const csrf = await getCsrfToken(started, USER_A);
    const agents = await json<{ agents: Array<{ id: string; name: string }> }>(
      fetchJson(started, USER_A, '/api/agents/catalog'),
    );
    expect(agents).toEqual({ agents: [{ id: 'pi', name: expect.any(String) }] });

    const skills = await json<{ skills: Array<{ id: string }> }>(
      fetchJson(started, USER_A, '/api/skills'),
    );
    expect(skills.skills.length).toBeGreaterThan(0);
    const skillId = skills.skills[0]!.id;
    await expect(fetchJson(started, USER_A, `/api/skills/${skillId}`))
      .resolves.toMatchObject({ status: 200 });
    const skillFiles = await json<{ files: unknown[] }>(
      fetchJson(started, USER_A, `/api/skills/${skillId}/files`),
    );
    expect(Array.isArray(skillFiles.files)).toBe(true);

    const systems = await json<{ designSystems: Array<{ id: string }> }>(
      fetchJson(started, USER_A, '/api/design-systems'),
    );
    expect(systems.designSystems.length).toBeGreaterThan(0);
    const designSystemId = systems.designSystems[0]!.id;
    await expect(fetchJson(started, USER_A, `/api/design-systems/${designSystemId}`))
      .resolves.toMatchObject({ status: 200 });

    await expectError(
      mutate(started, USER_A, csrf, 'POST', '/api/tools/design-systems/read', {
        designSystemId,
        path: 'DESIGN.md',
      }),
      403,
      'TOOL_TOKEN_MISSING',
    );
  });

  it('replays only owned project events and rejects a cursor copied to B before serializing events', async () => {
    const started = await start();
    const [csrfA, csrfB] = await Promise.all([
      getCsrfToken(started, USER_A),
      getCsrfToken(started, USER_B),
    ]);
    const projectA = await createProject(started, USER_A, csrfA, 'Events A');
    const projectB = await createProject(started, USER_B, csrfB, 'Events B');

    const liveA = await openSse(started, USER_A, `/api/projects/${projectA.id}/events`);
    const firstA = await createConversation(started, USER_A, csrfA, projectA.id, 'A first');
    const firstFrame = await readSseFrame(liveA, 5_000);
    expect(firstFrame).toMatchObject({ event: 'conversation-created', id: expect.any(String) });
    expect(firstFrame.data).toMatchObject({
      type: 'conversation-created',
      projectId: projectA.id,
      conversationId: firstA.id,
    });
    closeSse(liveA);

    const secondA = await createConversation(started, USER_A, csrfA, projectA.id, 'A second');
    const onlyB = await createConversation(started, USER_B, csrfB, projectB.id, 'B only');

    const replayA = await openSse(
      started,
      USER_A,
      `/api/projects/${projectA.id}/events`,
      firstFrame.id,
    );
    const replayed = await readSseFrame(replayA, 5_000);
    expect(replayed.data).toMatchObject({
      projectId: projectA.id,
      conversationId: secondA.id,
    });
    expect(replayed.raw).not.toContain(onlyB.id);
    closeSse(replayA);

    const copiedToB = await openSse(
      started,
      USER_B,
      `/api/projects/${projectB.id}/events`,
      firstFrame.id,
    );
    const rejected = await readSseFrame(copiedToB, 5_000);
    expect(rejected).toMatchObject({
      event: 'resync',
      data: { reason: 'cursor-invalid' },
    });
    expect(rejected.raw).not.toContain(firstA.id);
    expect(rejected.raw).not.toContain(secondA.id);
  });

  it('heartbeats a silent project stream', async () => {
    const started = await start();
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Silent stream');
    const stream = await openSse(started, USER_A, `/api/projects/${project.id}/events`);

    const frame = await readSseFrame(stream, 30_000);

    expect(frame.raw).toBe(': keepalive');
  }, 35_000);

  it('returns an explicit resync when a cursor falls out of fixed journal retention', async () => {
    const started = await start({ eventBudgetLimits: { maxEvents: 4 } });
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Cursor expiry');
    const stream = await openSse(started, USER_A, `/api/projects/${project.id}/events`);
    await createConversation(started, USER_A, csrf, project.id, 'expiring');
    const expired = await readSseFrame(stream, 5_000);
    expect(expired.id).toEqual(expect.any(String));
    closeSse(stream);

    for (let offset = 0; offset < 4; offset += 2) {
      const conversations = await Promise.all(Array.from({ length: 2 }, (_, index) => (
        json<{ conversation: { id: string } }>(mutate(
          started,
          USER_A,
          csrf,
          'POST',
          `/api/projects/${project.id}/conversations`,
          { title: `event-${offset + index}` },
        ))
      )));
      await Promise.all(conversations.map(({ conversation }) => expectSuccess(mutate(
        started,
        USER_A,
        csrf,
        'DELETE',
        `/api/projects/${project.id}/conversations/${conversation.id}`,
      ))));
    }

    const reconnect = await openSse(
      started,
      USER_A,
      `/api/projects/${project.id}/events`,
      expired.id,
    );
    expect(await readSseFrame(reconnect, 5_000)).toMatchObject({
      event: 'resync',
      data: { reason: 'cursor-expired' },
    });
    closeSse(reconnect);

    const current = await openSse(started, USER_A, `/api/projects/${project.id}/events`);
    const latest = await createConversation(started, USER_A, csrf, project.id, 'latest');
    const currentFrames: SseFrame[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      currentFrames.push(await readSseFrame(current, 5_000));
      const frame = currentFrames.at(-1)!;
      if (
        frame.event === 'resync'
        || (
          frame.data != null
          && typeof frame.data === 'object'
          && 'conversationId' in frame.data
          && frame.data.conversationId === latest.id
        )
      ) break;
    }
    expect(currentFrames).not.toContainEqual(expect.objectContaining({ event: 'resync' }));
    expect(currentFrames).toContainEqual(expect.objectContaining({
      event: 'conversation-created',
      data: expect.objectContaining({ conversationId: latest.id }),
    }));
  }, 120_000);

  it('releases a disconnected SSE client from the fixed per-user connection cap', async () => {
    const started = await start();
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Connection cleanup');
    const path = `/api/projects/${project.id}/events`;
    const streams = await Promise.all(Array.from({ length: 4 }, () => openSse(started, USER_A, path)));

    const overloaded = await fetch(`${started.url}${path}`, {
      headers: { ...auth(USER_A), accept: 'text/event-stream' },
    });
    expect(overloaded.headers.get('content-type')).toContain('application/json');
    await expectError(Promise.resolve(overloaded), 429, 'HOSTED_OVERLOADED');

    closeSse(streams[0]!);
    let replacement: SseStream | null = null;
    for (let attempt = 0; attempt < 50 && replacement == null; attempt += 1) {
      replacement = await tryOpenSse(started, USER_A, path);
      if (replacement == null) await delay(10);
    }
    expect(replacement).not.toBeNull();
  });

  it('cannot fall through to local-only, raw, wildcard, or static handlers', async () => {
    const started = await start();
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'No fallback');

    for (const [method, path] of [
      ['GET', '/api/app-config'],
      ['GET', `/api/projects/${project.id}/raw/index.html`],
      ['GET', `/api/projects/${project.id}/export/index.html`],
      ['GET', '/api/plugins'],
      ['GET', '/api/templates'],
      ['POST', '/api/tools/media/generate'],
      ['GET', '/artifacts/anything.html'],
      ['GET', '/definitely-not-a-hosted-route'],
      ['GET', '/api/projects/extra/path/segments'],
    ] as const) {
      const response = method === 'GET'
        ? fetchJson(started, USER_A, path)
        : mutate(started, USER_A, csrf, method, path, {});
      await expectError(response, 404, 'HOSTED_ROUTE_NOT_ALLOWED', `${method} ${path}`);
    }
  });

  it('rejects non-canonical raw paths before Express routing or ownership lookup', async () => {
    const started = await start();
    const csrf = await getCsrfToken(started, USER_A);
    const project = await createProject(started, USER_A, csrf, 'Canonical path');
    await expectSuccess(fetchJson(started, USER_A, `/api/projects/${project.id}`));

    for (const rawPath of [
      '/api/projects/%73ame-project-1',
      `/api//projects/${project.id}`,
      `/api/projects\\${project.id}`,
      `/api/projects/./${project.id}`,
      `/api/projects/${project.id}/.`,
      `/api/projects/${project.id}/`,
    ]) {
      await expectRawError(
        rawGet(started, USER_B, rawPath),
        404,
        'HOSTED_ROUTE_NOT_ALLOWED',
      );
    }
  });
});

async function start(
  runComposition: Pick<
    HostedTestComposition,
    | 'bodyReadTimeoutMs'
    | 'createRunId'
    | 'eventBudgetLimits'
    | 'shutdownRegistry'
    | 'startTurn'
  > = {},
): Promise<StartedServer> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'readable-hosted-pr07-'));
  const entityCounters = new Map<string, number>();
  runtimeRoots.push(runtimeRoot);
  const started = await startHostedServer({
    port: 0,
    host: '127.0.0.1',
    publicOrigin: PUBLIC_ORIGIN,
    runtimeRoot,
    testComposition: {
      createEntityId(kind, userKey) {
        const key = `${userKey}\0${kind}`;
        const next = (entityCounters.get(key) ?? 0) + 1;
        entityCounters.set(key, next);
        return `same-${kind}-${next}`;
      },
      resolveIdentity(request) {
        const user = request.headers.authorization?.replace(/^Bearer\s+/iu, '');
        if (user === USER_A) {
          return { userKey: USER_A, sessionKey: 'session-a', displayName: 'Alice' };
        }
        if (user === USER_B) {
          return { userKey: USER_B, sessionKey: 'session-b', displayName: 'Bob' };
        }
        return null;
      },
      ...runComposition,
    },
  });
  startedServers.push(started);
  return started;
}

function openPartialJson(
  started: StartedServer,
  user: string,
  csrfToken: string,
  path: string,
): {
  request: ClientRequest;
  flushed: Promise<void>;
  response: Promise<{ body: string; status: number }>;
} {
  let flushedResolve!: () => void;
  const flushed = new Promise<void>((resolve) => { flushedResolve = resolve; });
  let settled = false;
  let rejectResponse!: (error: unknown) => void;
  let partialRequest!: ClientRequest;
  const response = new Promise<{ body: string; status: number }>((resolve, reject) => {
    rejectResponse = reject;
    const request = httpRequest(`${started.url}${path}`, {
      method: 'POST',
      headers: {
        ...auth(user),
        'content-type': 'application/json',
        'content-length': '1024',
        'x-readable-studio-csrf': csrfToken,
        origin: PUBLIC_ORIGIN,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('end', () => {
        settled = true;
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          status: incoming.statusCode ?? 0,
        });
      });
    });
    partialRequest = request;
  });
  partialRequest.once('error', (error) => {
    if (!settled) rejectResponse(error);
  });
  partialRequest.write('{', flushedResolve);
  return { request: partialRequest, flushed, response };
}

async function expectRawError(
  response: Promise<{ body: string; status: number }>,
  status: number,
  code: string,
): Promise<void> {
  const result = await response;
  expect(result.status, result.body).toBe(status);
  expect(JSON.parse(result.body)).toMatchObject({ error: { code } });
}

async function createProject(
  started: StartedServer,
  user: string,
  csrfToken: string,
  title: string,
): Promise<Project> {
  const body = await json<{ project: Project }>(mutate(
    started,
    user,
    csrfToken,
    'POST',
    '/api/projects',
    { title, kind: 'prototype' },
  ));
  expect(body.project).toMatchObject({ id: expect.any(String), name: title });
  return body.project;
}

async function createConversation(
  started: StartedServer,
  user: string,
  csrfToken: string,
  projectId: string,
  title: string,
): Promise<Conversation> {
  const body = await json<{ conversation: Conversation }>(mutate(
    started,
    user,
    csrfToken,
    'POST',
    `/api/projects/${projectId}/conversations`,
    { title, sessionMode: 'design' },
  ));
  expect(body.conversation).toMatchObject({
    id: expect.any(String),
    projectId,
    title,
  });
  return body.conversation;
}

async function projectIds(started: StartedServer, user: string): Promise<string[]> {
  const body = await json<{ projects: Project[] }>(fetchJson(started, user, '/api/projects'));
  return body.projects.map(({ id }) => id);
}

async function getProject(started: StartedServer, user: string, projectId: string): Promise<Project> {
  const body = await json<{ project: Project }>(
    fetchJson(started, user, `/api/projects/${projectId}`),
  );
  return body.project;
}

async function getCsrfToken(started: StartedServer, user: string): Promise<string> {
  const response = await fetch(`${started.url}/api/hosted/session`, { headers: auth(user) });
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  return body.csrfToken;
}

function fetchJson(started: StartedServer, user: string, path: string): Promise<Response> {
  return fetch(`${started.url}${path}`, { headers: auth(user) });
}

function rawGet(
  started: StartedServer,
  user: string,
  rawPath: string,
): Promise<{ body: string; status: number }> {
  const target = new URL(started.url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      method: 'GET',
      path: rawPath,
      port: target.port,
      headers: auth(user),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        status: response.statusCode ?? 0,
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function mutate(
  started: StartedServer,
  user: string,
  csrfToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${started.url}${path}`, {
    method,
    headers: {
      ...auth(user),
      'content-type': 'application/json',
      'x-readable-studio-csrf': csrfToken,
      origin: PUBLIC_ORIGIN,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function auth(user: string): Record<string, string> {
  return { authorization: `Bearer ${user}` };
}

async function json<T = unknown>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBeGreaterThanOrEqual(200);
  expect(response.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}

async function expectSuccess(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBeGreaterThanOrEqual(200);
  expect(response.status, text).toBeLessThan(300);
}

async function expectOwnedNotFound(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, text).toBe(404);
  const body = JSON.parse(text) as { error?: { code?: string } };
  expect(body.error?.code).not.toBe('HOSTED_ROUTE_NOT_ALLOWED');
}

async function expectError(
  responsePromise: Promise<Response>,
  status: number,
  code: string,
  label = code,
): Promise<void> {
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status, label).toBe(status);
  expect(JSON.parse(text), label).toMatchObject({ error: { code } });
}

function commentBody(note: string): Record<string, unknown> {
  return {
    note,
    target: {
      filePath: 'index.html',
      elementId: 'hero',
      selector: '#hero',
      label: 'Hero',
      text: 'Headline',
      position: { x: 0, y: 0, width: 100, height: 40 },
      htmlHint: '<section id="hero">',
    },
  };
}

function runIntent(
  projectId: string,
  conversationId: string,
  assistantMessageId: string,
  clientRequestId: string,
): Record<string, unknown> {
  return {
    projectId,
    conversationId,
    assistantMessageId,
    agentId: 'pi',
    message: 'Build the requested design',
    clientRequestId,
  };
}

async function waitForRunStatus(
  started: StartedServer,
  user: string,
  runId: string,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await fetchJson(started, user, `/api/runs/${runId}`);
    if (response.ok) {
      const run = await response.json() as { status?: string };
      if (run.status === expectedStatus) return;
    } else {
      await response.arrayBuffer();
    }
    await delay(10);
  }
  throw new Error(`run ${runId} did not reach ${expectedStatus}`);
}

async function openSse(
  started: StartedServer,
  user: string,
  path: string,
  after?: string,
): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${started.url}${path}`, {
    headers: {
      ...auth(user),
      accept: 'text/event-stream',
      ...(after === undefined ? {} : { 'last-event-id': after }),
    },
    signal: controller.signal,
  });
  expect(response.status, await bodyOnFailure(response)).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (response.body == null) throw new Error('SSE response had no body');
  const stream: SseStream = {
    buffer: '',
    controller,
    reader: response.body.getReader(),
    response,
  };
  openStreams.push(stream);
  return stream;
}

async function tryOpenSse(
  started: StartedServer,
  user: string,
  path: string,
): Promise<SseStream | null> {
  const controller = new AbortController();
  const response = await fetch(`${started.url}${path}`, {
    headers: { ...auth(user), accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (response.status === 429) {
    await response.arrayBuffer();
    return null;
  }
  expect(response.status).toBe(200);
  if (response.body == null) throw new Error('SSE response had no body');
  const stream: SseStream = {
    buffer: '',
    controller,
    reader: response.body.getReader(),
    response,
  };
  openStreams.push(stream);
  return stream;
}

async function readSseFrame(stream: SseStream, timeoutMs: number): Promise<SseFrame> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const normalized = stream.buffer.replaceAll('\r\n', '\n');
    const boundary = normalized.indexOf('\n\n');
    if (boundary >= 0) {
      const raw = normalized.slice(0, boundary);
      stream.buffer = normalized.slice(boundary + 2);
      const lines = raw.split('\n');
      const event = field(lines, 'event');
      const id = field(lines, 'id');
      const dataText = field(lines, 'data');
      return {
        raw,
        ...(event === undefined ? {} : { event }),
        ...(id === undefined ? {} : { id }),
        ...(dataText === undefined ? {} : { data: JSON.parse(dataText) as unknown }),
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timed out waiting for an SSE frame');
    const chunk = await withTimeout(stream.reader.read(), remaining, 'SSE frame');
    if (chunk.done) throw new Error('SSE stream ended before the expected frame');
    stream.buffer += new TextDecoder().decode(chunk.value, { stream: true });
  }
}

function field(lines: string[], name: string): string | undefined {
  const prefix = `${name}:`;
  const values = lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trimStart());
  return values.length === 0 ? undefined : values.join('\n');
}

function closeSse(stream: SseStream): void {
  const index = openStreams.indexOf(stream);
  if (index >= 0) openStreams.splice(index, 1);
  stream.controller.abort();
  void stream.reader.cancel().catch(() => undefined);
}

async function bodyOnFailure(response: Response): Promise<string> {
  return response.ok ? '' : response.clone().text();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTestSession(
  input: Parameters<NonNullable<HostedTestComposition['startTurn']>>[0],
): Promise<string> {
  await mkdir(input.capabilities.sessionRoot, { recursive: true });
  const sessionReference = join(
    input.capabilities.sessionRoot,
    `${input.capabilities.runId}.jsonl`,
  );
  await writeFile(
    sessionReference,
    `${JSON.stringify({ type: 'session', cwd: input.capabilities.projectRoot })}\n`,
  );
  return sessionReference;
}

async function removeRuntimeRoot(runtimeRoot: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'readable-hosted-pr07-');
  if (!runtimeRoot.startsWith(expectedPrefix)) {
    throw new Error(`refusing to remove unexpected runtime root: ${runtimeRoot}`);
  }
  await rm(runtimeRoot, { recursive: true, force: true });
}
