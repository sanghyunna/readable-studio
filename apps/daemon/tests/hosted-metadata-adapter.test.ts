import { describe, expect, it } from 'vitest';
import {
  createHostedMetadataAdapter,
  HOSTED_METADATA_RESOURCE_LIMITS,
  HostedMetadataAdapterError,
  type HostedMetadataAuthority,
  type HostedMetadataMutationOperation,
  type HostedMetadataOperation,
  type HostedMetadataReadOperation,
  type HostedMetadataSemanticDispatcher,
} from '../src/hosted-metadata-adapter.js';

const AUTHORITY: HostedMetadataAuthority = Object.freeze({
  userKey: 'issuer:subject-a',
  generation: 7,
});

const TARGET = {
  filePath: 'src/index.html',
  elementId: 'hero',
  selector: '#hero',
  label: 'Hero',
  text: 'Hello',
  position: { x: 1, y: 2, width: 300, height: 200 },
  htmlHint: '<section id="hero">',
} as const;

const CHECKPOINT = {
  id: 'checkpoint-1',
  projectId: 'project-1',
  conversationId: null,
  messageId: null,
  runId: null,
  kind: 'manual',
  createdAt: 1,
  rootPathHash: 'root-hash',
  fileCount: 1,
  totalBytes: 10,
  manifestHash: 'manifest-hash',
  restoreModes: ['files_only'],
} as const;

describe('hosted metadata adapter', () => {
  it('freezes conservative per-user metadata cardinality ceilings', () => {
    expect(HOSTED_METADATA_RESOURCE_LIMITS).toEqual({
      commentsPerUser: 10_000,
      conversationsPerUser: 1_000,
      messagesPerUser: 10_000,
      projectsPerUser: 100,
      tabsPerUser: 1_000,
    });
  });

  it('dispatches every read through the supplied lease-bound semantic reader', async () => {
    const harness = createHarness();
    const requests: readonly unknown[] = [
      { kind: 'projects.list' },
      { kind: 'project.get', projectId: 'project-1' },
      { kind: 'conversations.list', projectId: 'project-1' },
      { kind: 'messages.list', projectId: 'project-1', conversationId: 'conversation-1' },
      { kind: 'comments.list', projectId: 'project-1', conversationId: 'conversation-1' },
      { kind: 'tabs.get', projectId: 'project-1' },
      { kind: 'checkpoints.list', projectId: 'project-1' },
      { kind: 'checkpoints.list', projectId: 'project-1', conversationId: 'conversation-1' },
      { kind: 'checkpoint.get', projectId: 'project-1', checkpointId: 'checkpoint-1' },
      { kind: 'checkpoint.diff', projectId: 'project-1', checkpointId: 'checkpoint-1', base: 'current' },
    ];

    for (const request of requests) await harness.adapter.dispatch(AUTHORITY, request);

    expect(harness.readCalls).toHaveLength(requests.length);
    expect(harness.mutationCalls).toHaveLength(0);
    expect(harness.readCalls.every(({ authority }) => authority.userKey === AUTHORITY.userKey
      && authority.generation === AUTHORITY.generation)).toBe(true);
  });

  it('dispatches every mutation through the supplied per-user lane exactly once', async () => {
    const harness = createHarness();
    const requests: readonly unknown[] = [
      { kind: 'project.create', body: { title: 'Project', kind: 'prototype', catalogueId: 'catalogue-1' } },
      { kind: 'project.patch', projectId: 'project-1', body: {} },
      { kind: 'project.delete', projectId: 'project-1' },
      {
        kind: 'conversation.create',
        projectId: 'project-1',
        body: {
          title: 'Conversation',
          sessionMode: 'design',
          seedFromConversationId: 'conversation-0',
          forkAfterMessageId: 'message-0',
        },
      },
      { kind: 'conversation.patch', projectId: 'project-1', conversationId: 'conversation-1', body: {} },
      { kind: 'conversation.delete', projectId: 'project-1', conversationId: 'conversation-1' },
      {
        kind: 'message.upsert',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        body: {
          role: 'assistant',
          content: 'Done',
          events: [{ kind: 'text', text: 'Done' }],
          runId: 'run-1',
          runStatus: 'succeeded',
          attachmentIds: ['attachment-1'],
          commentIds: ['comment-1'],
          producedFileIds: ['file-1'],
        },
      },
      {
        kind: 'comment.create',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        body: {
          target: { ...TARGET, style: { color: '#fff' }, selectionKind: 'element' },
          note: 'Adjust this',
          attachments: [{ path: 'attachments/reference.png', name: 'reference.png' }],
        },
      },
      {
        kind: 'tabs.put',
        projectId: 'project-1',
        body: {
          tabs: ['src/index.html'],
          active: 'src/index.html',
          browserTabs: [{ id: 'preview-1', label: 'Preview', insertAfter: null }],
        },
      },
    ];

    for (const request of requests) {
      const previousCount = harness.mutationCalls.length;
      await harness.adapter.dispatch(AUTHORITY, request);
      expect(harness.mutationCalls).toHaveLength(previousCount + 1);
    }

    expect(harness.readCalls).toHaveLength(0);
    expect(harness.mutationCalls).toHaveLength(requests.length);
    expect(harness.mutationCalls.every(({ authority }) => authority.userKey === AUTHORITY.userKey
      && authority.generation === AUTHORITY.generation)).toBe(true);
  });

  it('keeps identical entity identifiers scoped by the supplied owner and generation token', async () => {
    const harness = createHarness();
    const request = { kind: 'project.get', projectId: 'same-project-id' };
    const authorityA = { userKey: 'owner-a', generation: 3 };
    const authorityB = { userKey: 'owner-b', generation: 11 };

    await harness.adapter.dispatch(authorityA, request);
    await harness.adapter.dispatch(authorityB, request);

    expect(harness.readCalls).toEqual([
      { authority: authorityA, operation: request },
      { authority: authorityB, operation: request },
    ]);
  });

  it('rejects owner, root, external, plugin, and template authority before dispatch', async () => {
    const harness = createHarness();
    const forbiddenFields = [
      'owner',
      'ownerId',
      'userKey',
      'storageKey',
      'baseDir',
      'root',
      'rootDir',
      'fsPath',
      'projectLocationId',
      'externalWorkingDirectory',
      'pluginId',
      'templateId',
    ] as const;
    const invalidRequests = [
      ...forbiddenFields.map((field) => ({
        kind: 'project.create',
        body: { title: 'Project', [field]: 'attacker-controlled' },
      })),
      { kind: 'project.get', projectId: 'project-1', owner: 'owner-b' },
      {
        kind: 'conversation.create',
        projectId: 'project-1',
        body: { seedMessages: [], appliedPluginSnapshot: { id: 'plugin-1' } },
      },
      {
        kind: 'message.upsert',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        body: { role: 'user', content: 'Hello', createdAt: 1, attachments: [{ path: 'C:/secret' }] },
      },
      {
        kind: 'comment.create',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        body: { target: { ...TARGET, rootPath: 'C:/secret' }, note: 'Note' },
      },
      {
        kind: 'tabs.put',
        projectId: 'project-1',
        body: { tabs: ['src/index.html'], active: 'src/index.html', browserTabs: [], cwd: 'C:/secret' },
      },
      { kind: 'checkpoint.diff', projectId: 'project-1', checkpointId: 'checkpoint-1', root: 'C:/secret' },
    ];

    for (const request of invalidRequests) {
      await expect(harness.adapter.dispatch(AUTHORITY, request)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }

    expect(harness.readCalls).toHaveLength(0);
    expect(harness.mutationCalls).toHaveLength(0);
  });

  it('matches the trusted authority boundary and preserves strict request identifiers', async () => {
    const harness = createHarness();
    const accepted = { userKey: 'ü'.repeat(512), generation: 1 };

    await expect(harness.adapter.dispatch(accepted, { kind: 'project.delete', projectId: 'a'.repeat(128) }))
      .resolves.toEqual({ ok: true });
    expect(harness.mutationCalls).toHaveLength(1);

    for (const authority of [
      { userKey: 'a'.repeat(1_025), generation: 1 },
      { userKey: '\ud800', generation: 1 },
      { userKey: 'owner\u001fkey', generation: 1 },
      { userKey: 'owner', generation: 0 },
    ]) {
      await expect(harness.adapter.dispatch(authority, { kind: 'projects.list' }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }

    for (const projectId of ['a'.repeat(129), '..', 'a/b', 'C:drive']) {
      await expect(harness.adapter.dispatch(AUTHORITY, { kind: 'project.get', projectId }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }

    expect(harness.readCalls).toHaveLength(0);
    expect(harness.mutationCalls).toHaveLength(1);
  });

  it('enforces hosted payload, collection, and canonical-path bounds before dispatch', async () => {
    const harness = createHarness();
    const mutation = (body: unknown) => harness.adapter.dispatch(AUTHORITY, {
      kind: 'message.upsert',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      body,
    });

    await expect(harness.adapter.dispatch(AUTHORITY, {
      kind: 'project.create',
      body: { title: 'é'.repeat(128) },
    })).resolves.toHaveProperty('project.id');
    await expect(harness.adapter.dispatch(AUTHORITY, {
      kind: 'project.create',
      body: { title: `${'é'.repeat(128)}a` },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(mutation({ role: 'user', content: 'a'.repeat(1024 * 1024) }))
      .resolves.toHaveProperty('message.id');
    await expect(mutation({ role: 'user', content: 'a'.repeat(1024 * 1024 + 1) }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(mutation({
      role: 'assistant',
      content: '',
      events: Array.from({ length: 2_001 }, () => ({ kind: 'text', text: '' })),
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(harness.adapter.dispatch(AUTHORITY, {
      kind: 'comment.create',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      body: { target: TARGET, note: 'a'.repeat(64 * 1024 + 1) },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(harness.adapter.dispatch(AUTHORITY, {
      kind: 'tabs.put',
      projectId: 'project-1',
      body: { tabs: ['../secret'], active: null },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(harness.mutationCalls).toHaveLength(2);
  });

  it('returns only hosted contract fields from semantic responses', async () => {
    const leakedRoot = 'C:/users/owner-a/project';
    const harness = createHarness((operation) => {
      if (operation.kind === 'project.get') {
        return {
          project: {
            ...project(),
            owner: 'owner-a',
            storageKey: 'od1_secret',
            resolvedDir: leakedRoot,
            pluginId: 'plugin-secret',
            templateId: 'template-secret',
          },
        };
      }
      if (operation.kind === 'message.upsert') {
        return {
          message: {
            ...message(),
            telemetryFinalized: true,
            attachments: [{ path: `${leakedRoot}/secret.png` }],
            appliedPluginSnapshot: { id: 'plugin-secret' },
            eventsLogPath: `${leakedRoot}/events.jsonl`,
          },
        };
      }
      if (operation.kind === 'checkpoint.diff') {
        return {
          checkpoint: { ...CHECKPOINT, rootPath: leakedRoot },
          files: [{ path: 'src/index.html', status: 'modified', fromHash: null, toHash: 'hash', absolutePath: leakedRoot }],
          conflicts: [],
          snapshotRoot: leakedRoot,
        };
      }
      return responseFor(operation);
    });

    const projectResult = await harness.adapter.dispatch(AUTHORITY, {
      kind: 'project.get',
      projectId: 'project-1',
    });
    const messageResult = await harness.adapter.dispatch(AUTHORITY, {
      kind: 'message.upsert',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      body: { role: 'assistant', content: 'Done' },
    });
    const diffResult = await harness.adapter.dispatch(AUTHORITY, {
      kind: 'checkpoint.diff',
      projectId: 'project-1',
      checkpointId: 'checkpoint-1',
    });

    expect(projectResult).toEqual({ project: project() });
    expect(messageResult).toEqual({ message: message() });
    expect(diffResult).toEqual({
      checkpoint: CHECKPOINT,
      files: [{ path: 'src/index.html', status: 'modified', fromHash: null, toHash: 'hash' }],
      conflicts: [],
    });
    expect(JSON.stringify([projectResult, messageResult, diffResult])).not.toContain(leakedRoot);
    expect(JSON.stringify([projectResult, messageResult, diffResult])).not.toMatch(/owner|storageKey|plugin|template|absolutePath/u);
  });

  it('turns malformed semantic results into adapter failures', async () => {
    const harness = createHarness(() => ({ project: { id: 'project-1', resolvedDir: 'C:/secret' } }));

    await expect(harness.adapter.dispatch(AUTHORITY, { kind: 'project.get', projectId: 'project-1' }))
      .rejects.toEqual(expect.objectContaining<Partial<HostedMetadataAdapterError>>({
        name: 'HostedMetadataAdapterError',
        code: 'INTERNAL_ERROR',
      }));
  });

  it.each([
    ['projects.list', 'projects', HOSTED_METADATA_RESOURCE_LIMITS.projectsPerUser],
    ['conversations.list', 'conversations', HOSTED_METADATA_RESOURCE_LIMITS.conversationsPerUser],
    ['messages.list', 'messages', HOSTED_METADATA_RESOURCE_LIMITS.messagesPerUser],
    ['comments.list', 'comments', HOSTED_METADATA_RESOURCE_LIMITS.commentsPerUser],
  ] as const)('rejects an oversized %s semantic response before mapping it', async (
    kind,
    field,
    limit,
  ) => {
    const request = kind === 'projects.list'
      ? { kind }
      : kind === 'conversations.list'
        ? { kind, projectId: 'project-1' }
        : { kind, projectId: 'project-1', conversationId: 'conversation-1' };
    const harness = createHarness(() => ({ [field]: Array(limit + 1).fill(null) }));

    await expect(harness.adapter.dispatch(AUTHORITY, request)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('rejects oversized tab collections returned by the semantic layer', async () => {
    const harness = createHarness(() => ({
      tabs: Array.from({ length: 101 }, (_, index) => `file-${index}.html`),
      active: null,
      browserTabs: [],
    }));

    await expect(harness.adapter.dispatch(AUTHORITY, {
      kind: 'tabs.get',
      projectId: 'project-1',
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});

function createHarness(respond: (operation: HostedMetadataOperation) => unknown = responseFor): {
  readonly adapter: ReturnType<typeof createHostedMetadataAdapter>;
  readonly readCalls: Array<{ authority: HostedMetadataAuthority; operation: HostedMetadataReadOperation }>;
  readonly mutationCalls: Array<{ authority: HostedMetadataAuthority; operation: HostedMetadataMutationOperation }>;
} {
  const readCalls: Array<{ authority: HostedMetadataAuthority; operation: HostedMetadataReadOperation }> = [];
  const mutationCalls: Array<{ authority: HostedMetadataAuthority; operation: HostedMetadataMutationOperation }> = [];
  const dispatcher: HostedMetadataSemanticDispatcher = {
    async read(authority, operation) {
      readCalls.push({ authority, operation });
      return respond(operation);
    },
    async mutateInLane(authority, operation) {
      mutationCalls.push({ authority, operation });
      return respond(operation);
    },
  };
  return { adapter: createHostedMetadataAdapter(dispatcher), readCalls, mutationCalls };
}

function responseFor(operation: HostedMetadataOperation): unknown {
  switch (operation.kind) {
    case 'projects.list':
      return { projects: [project()] };
    case 'project.create':
    case 'project.get':
    case 'project.patch':
      return { project: project() };
    case 'project.delete':
    case 'conversation.delete':
      return { ok: true };
    case 'conversations.list':
      return { conversations: [conversation()] };
    case 'conversation.create':
    case 'conversation.patch':
      return { conversation: conversation() };
    case 'messages.list':
      return { messages: [message()] };
    case 'message.upsert':
      return { message: message() };
    case 'comments.list':
      return { comments: [comment()] };
    case 'comment.create':
      return { comment: comment() };
    case 'tabs.get':
    case 'tabs.put':
      return {
        tabs: ['src/index.html'],
        active: 'src/index.html',
        browserTabs: [{ id: 'preview-1', label: 'Preview', insertAfter: null }],
        hasSavedState: true,
        updatedAt: 2,
      };
    case 'checkpoints.list':
      return { checkpoints: [CHECKPOINT] };
    case 'checkpoint.get':
      return { checkpoint: CHECKPOINT };
    case 'checkpoint.diff':
      return { checkpoint: CHECKPOINT, files: [], conflicts: [] };
  }
}

function project() {
  return { id: 'project-1', name: 'Project', createdAt: 1, updatedAt: 2 } as const;
}

function conversation() {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    title: 'Conversation',
    sessionMode: 'design',
    messageCount: 1,
    createdAt: 1,
    updatedAt: 2,
    totalDurationMs: 10,
    latestRun: { status: 'succeeded', startedAt: 1, endedAt: 2, durationMs: 1 },
  } as const;
}

function message() {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'Done',
    agentId: 'agent-1',
    agentName: 'Agent',
    events: [{ kind: 'text', text: 'Done' }],
    runId: 'run-1',
    runStatus: 'succeeded',
    resumable: false,
    lastRunEventId: 'event-1',
    startedAt: 1,
    endedAt: 2,
    sessionMode: 'design',
    attachmentIds: ['attachment-1'],
    commentIds: ['comment-1'],
    producedFileIds: ['file-1'],
    createdAt: 1,
  } as const;
}

function comment() {
  return {
    id: 'comment-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    ...TARGET,
    note: 'Adjust this',
    attachments: [{ path: 'attachments/reference.png', name: 'reference.png' }],
    status: 'open',
    createdAt: 1,
    updatedAt: 2,
  } as const;
}
