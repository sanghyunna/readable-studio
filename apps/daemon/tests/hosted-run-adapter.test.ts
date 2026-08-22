import { describe, expect, it, vi } from 'vitest';

import {
  HostedRunAdapterError,
  createHostedRunAdapter,
  type HostedRunAuthority,
  type HostedRunMutationOperation,
  type HostedRunReadOperation,
  type HostedRunSemanticDispatcher,
  type HostedRunStartOperation,
} from '../src/hosted-run-adapter.js';

const authority: HostedRunAuthority = { userKey: 'issuer\0subject/../opaque', generation: 7 };

function runIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'project-1',
    conversationId: 'conversation-1',
    assistantMessageId: 'message-1',
    agentId: 'codex',
    message: 'build it',
    clientRequestId: 'retry_1',
    ...overrides,
  };
}

function dispatcher(
  resolve: (operation: HostedRunReadOperation | HostedRunMutationOperation) => unknown,
  start: (operation: HostedRunStartOperation) => unknown = () => ({
    runId: 'run-1',
    conversationId: 'conversation-1',
    assistantMessageId: 'message-1',
  }),
): HostedRunSemanticDispatcher & {
  reads: HostedRunReadOperation[];
  mutations: HostedRunMutationOperation[];
  starts: HostedRunStartOperation[];
} {
  const reads: HostedRunReadOperation[] = [];
  const mutations: HostedRunMutationOperation[] = [];
  const starts: HostedRunStartOperation[] = [];
  return {
    reads,
    mutations,
    starts,
    async read(_authority, operation) {
      reads.push(operation);
      return resolve(operation);
    },
    async mutateInLane(_authority, operation, execute) {
      mutations.push(operation);
      return execute ? await execute() : resolve(operation);
    },
    async startChat(_authority, operation) {
      starts.push(operation);
      return start(operation);
    },
  };
}

describe('hosted run adapter', () => {
  it('normalizes the exact closed run/chat intent and starts it only inside the mutation lane', async () => {
    const order: string[] = [];
    const semantic: HostedRunSemanticDispatcher = {
      async read() { throw new Error('unexpected read'); },
      async mutateInLane(_authority, _operation, execute) {
        order.push('lane:enter');
        const result = await execute!();
        order.push('lane:exit');
        return result;
      },
      async startChat(scopedAuthority, operation) {
        order.push('start');
        expect(scopedAuthority).toEqual(authority);
        expect(Object.isFrozen(scopedAuthority)).toBe(true);
        expect(operation).toEqual({
          kind: 'chat.create',
          intent: {
            projectId: 'project-1',
            conversationId: 'conversation-1',
            assistantMessageId: 'message-1',
            agentId: 'codex',
            message: 'build it',
            clientRequestId: 'retry_1',
            currentPrompt: 'build it',
            sessionMode: 'design',
            skillIds: [],
            designSystemId: null,
            attachmentIds: [],
            commentAttachmentIds: [],
            model: null,
            reasoning: null,
            locale: 'en',
            contextSelectionIds: [],
          },
        });
        expect(Object.isFrozen(operation.intent)).toBe(true);
        return {
          runId: 'run-1',
          conversationId: 'conversation-1',
          assistantMessageId: 'message-1',
          eventsLogPath: 'C:\\owners\\a\\events.jsonl',
          grant: { token: 'secret' },
        };
      },
    };
    const adapter = createHostedRunAdapter(semantic);

    await expect(adapter.dispatch(authority, {
      kind: 'chat.create',
      body: runIntent(),
    })).resolves.toEqual({
      runId: 'run-1',
      conversationId: 'conversation-1',
      assistantMessageId: 'message-1',
    });
    expect(order).toEqual(['lane:enter', 'start', 'lane:exit']);

    for (const forbidden of [
      'owner', 'userId', 'root', 'systemPrompt', 'tools', 'providerEndpoint',
      'environment', 'appliedPluginSnapshotId',
    ]) {
      await expect(adapter.dispatch(authority, {
        kind: 'run.create',
        body: runIntent({ [forbidden]: 'attacker-controlled' }),
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('accepts only bounded read shapes and emits allowlisted status and AGUI DTOs', async () => {
    const semantic = dispatcher((operation) => {
      if (operation.kind === 'runs.list') {
        return { runs: [{
          id: 'run-1', projectId: 'project-1', conversationId: 'conversation-1',
          assistantMessageId: 'message-1', agentId: 'codex', status: 'running',
          createdAt: 1, updatedAt: 2, exitCode: null, resumable: false,
          eventsLogPath: 'C:\\secret\\events.jsonl', token: 'secret', raw: { event: 'raw' },
        }] };
      }
      if (operation.kind === 'run.agui') {
        return { events: [
          {
            kind: 'tool_call', runId: 'run-1', ts: 4, toolName: 'read',
            args: {
              owner: 'not-public', token: 'secret', path: 'C:\\secret\\file.txt',
              nested: { safe: 'yes' },
            },
            raw: { token: 'secret' },
          },
          { kind: 'raw', runId: 'run-1', ts: 5, data: { token: 'secret' } },
        ] };
      }
      throw new Error(`unexpected operation ${operation.kind}`);
    });
    const adapter = createHostedRunAdapter(semantic);

    await expect(adapter.dispatch(authority, {
      kind: 'runs.list', projectId: 'project-1', status: 'running',
    })).resolves.toEqual({ runs: [{
      id: 'run-1', projectId: 'project-1', conversationId: 'conversation-1',
      assistantMessageId: 'message-1', agentId: 'codex', status: 'running',
      createdAt: 1, updatedAt: 2, exitCode: null, resumable: false,
    }] });
    expect(semantic.reads[0]).toEqual({
      kind: 'runs.list', projectId: 'project-1', status: 'running',
    });

    await expect(adapter.dispatch(authority, {
      kind: 'run.agui', runId: 'run-1',
    })).resolves.toEqual({ events: [{
      kind: 'tool_call', runId: 'run-1', ts: 4, toolName: 'read',
      args: { nested: { safe: 'yes' } },
    }] });

    for (const invalid of [
      { kind: 'runs.list', status: 'unknown' },
      { kind: 'runs.list', body: {} },
      { kind: 'run.status', runId: 'run-1', query: {} },
      { kind: 'run.agui', runId: '../escape' },
    ]) await expect(adapter.dispatch(authority, invalid)).rejects.toBeInstanceOf(HostedRunAdapterError);
  });

  it('projects status and every GenUI read without storage or plugin authority', async () => {
    const surface = {
      id: 'row-1', projectId: 'project-1', conversationId: 'conversation-1',
      runId: 'run-1', surfaceId: 'surface-1', kind: 'choice', persist: 'conversation',
      value: { selected: 'a' }, status: 'pending', respondedBy: null,
      requestedAt: 1, respondedAt: null, expiresAt: null,
      pluginSnapshotId: 'snapshot-secret', schemaDigest: 'digest-secret',
      storagePath: 'C:\\owners\\a\\surface.json', grant: { token: 'secret' },
    };
    const semantic = dispatcher((operation) => {
      switch (operation.kind) {
        case 'run.status':
          return {
            id: operation.runId, projectId: 'project-1', conversationId: 'conversation-1',
            assistantMessageId: 'message-1', agentId: 'codex', status: 'failed',
            createdAt: 1, updatedAt: 2, exitCode: 1, resumable: true,
            errorCode: 'AGENT_EXECUTION_FAILED', error: 'C:\\secret',
            eventsLogPath: 'C:\\owners\\a\\events.jsonl', toolBundle: { token: 'secret' },
          };
        case 'run.genui.list':
          return { runId: operation.runId, surfaces: [surface], grant: 'secret' };
        case 'project.genui.list':
          return { projectId: operation.projectId, surfaces: [surface], root: 'C:\\secret' };
        case 'run.genui.surface':
          return {
            ...surface,
            spec: {
              id: operation.surfaceId, kind: 'choice', persist: 'conversation',
              schema: {
                owner: { type: 'string' },
                path: { type: 'string', description: 'ordinary schema property' },
              },
              prompt: 'choose', timeout: 10, onTimeout: 'skip', default: { path: '/choice/a' },
              pluginSnapshotId: 'snapshot-secret', capabilitiesRequired: ['filesystem'],
            },
          };
        default:
          throw new Error(`unexpected operation ${operation.kind}`);
      }
    });
    const adapter = createHostedRunAdapter(semantic);

    await expect(adapter.dispatch(authority, {
      kind: 'run.status', runId: 'run-1',
    })).resolves.toEqual({
      id: 'run-1', projectId: 'project-1', conversationId: 'conversation-1',
      assistantMessageId: 'message-1', agentId: 'codex', status: 'failed',
      createdAt: 1, updatedAt: 2, exitCode: 1, resumable: true,
      errorCode: 'AGENT_EXECUTION_FAILED',
    });
    await expect(adapter.dispatch(authority, {
      kind: 'run.genui.list', runId: 'run-1',
    })).resolves.toEqual({ runId: 'run-1', surfaces: [{
      id: 'row-1', projectId: 'project-1', conversationId: 'conversation-1',
      runId: 'run-1', surfaceId: 'surface-1', kind: 'choice', persist: 'conversation',
      value: { selected: 'a' }, status: 'pending', respondedBy: null,
      requestedAt: 1, respondedAt: null, expiresAt: null,
    }] });
    await expect(adapter.dispatch(authority, {
      kind: 'project.genui.list', projectId: 'project-1',
    })).resolves.toMatchObject({ projectId: 'project-1', surfaces: [{ surfaceId: 'surface-1' }] });
    await expect(adapter.dispatch(authority, {
      kind: 'run.genui.surface', runId: 'run-1', surfaceId: 'surface-1',
    })).resolves.toMatchObject({
      surfaceId: 'surface-1',
      spec: {
        id: 'surface-1',
        schema: {
          owner: { type: 'string' },
          path: { type: 'string', description: 'ordinary schema property' },
        },
        default: { path: '/choice/a' },
      },
    });
    expect(semantic.reads.map(({ kind }) => kind)).toEqual([
      'run.status', 'run.genui.list', 'project.genui.list', 'run.genui.surface',
    ]);
  });

  it('enforces retry, intent-array, authority, and accessor bounds before dispatch', async () => {
    const semantic = dispatcher(() => ({ ok: true }));
    const adapter = createHostedRunAdapter(semantic);
    const validBoundaryAuthority = { userKey: 'é'.repeat(512), generation: 1 };
    const started = adapter.dispatch(validBoundaryAuthority, {
      kind: 'run.create', body: runIntent(),
    });
    await expect(started).resolves.toMatchObject({ runId: 'run-1' });

    for (const invalid of [
      { kind: 'run.create', body: runIntent({ clientRequestId: 'contains space' }) },
      { kind: 'run.create', body: runIntent({ attachmentIds: Array(13).fill('attachment-1') }) },
    ]) await expect(adapter.dispatch(authority, invalid)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(adapter.dispatch({ userKey: 'é'.repeat(512) + 'x', generation: 1 }, {
      kind: 'runs.list',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const accessor = { kind: 'runs.list' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'owner', { enumerable: true, get: () => 'attacker' });
    await expect(adapter.dispatch(authority, accessor)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(semantic.reads).toHaveLength(0);
  });

  it('routes every mutation through mutateInLane and waits for cancel reconciliation', async () => {
    let reconcile!: (value: unknown) => void;
    const reconciliation = new Promise<unknown>((resolve) => { reconcile = resolve; });
    const mutations: HostedRunMutationOperation[] = [];
    const semantic: HostedRunSemanticDispatcher = {
      async read() { throw new Error('unexpected read'); },
      async startChat() { throw new Error('unexpected start'); },
      async mutateInLane(_authority, operation) {
        mutations.push(operation);
        if (operation.kind === 'run.cancel') return reconciliation;
        if (operation.kind === 'run.feedback') return { status: 'accepted', secret: 'hidden' };
        if (operation.kind === 'project.genui.revoke') {
          return { ok: true, invalidated: 2, grant: 'hidden' };
        }
        throw new Error(`unexpected mutation ${operation.kind}`);
      },
    };
    const adapter = createHostedRunAdapter(semantic);
    let settled = false;
    const cancel = adapter.dispatch(authority, { kind: 'run.cancel', runId: 'run-1' })
      .then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    reconcile({ ok: true, child: { pid: 1 }, token: 'hidden' });
    await expect(cancel).resolves.toEqual({ ok: true });

    await expect(adapter.dispatch(authority, {
      kind: 'run.feedback',
      runId: 'run-1',
      body: {
        projectId: 'project-1', conversationId: 'conversation-1',
        assistantMessageId: 'message-1', rating: 'positive',
        reasonCodes: ['matched_request'], hasCustomReason: false, customReason: '',
      },
    })).resolves.toEqual({ status: 'accepted' });
    await expect(adapter.dispatch(authority, {
      kind: 'project.genui.revoke', projectId: 'project-1', surfaceId: 'surface-1',
    })).resolves.toEqual({ ok: true, invalidated: 2 });
    expect(mutations.map(({ kind }) => kind)).toEqual([
      'run.cancel', 'run.feedback', 'project.genui.revoke',
    ]);

    for (const invalid of [
      { kind: 'run.cancel', runId: 'run-1', body: {} },
      { kind: 'project.genui.revoke', projectId: 'project-1', surfaceId: 'surface-1', body: {} },
      {
        kind: 'run.feedback', runId: 'run-1',
        body: {
          projectId: 'project-1', conversationId: 'conversation-1',
          assistantMessageId: 'message-1', rating: 'negative',
          reasonCodes: Array(9).fill('missed_request'), hasCustomReason: false, customReason: '',
        },
      },
    ]) await expect(adapter.dispatch(authority, invalid)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('keeps GenUI value opaque while rejecting non-JSON and sanitizing surface authority', async () => {
    const semantic = dispatcher((operation) => {
      if (operation.kind === 'run.genui.respond') {
        return {
          ok: true,
          surface: {
            id: 'row-1', projectId: 'project-1', conversationId: 'conversation-1',
            runId: 'run-1', surfaceId: 'surface-1', kind: 'form', persist: 'run',
            value: operation.body.value, status: 'resolved', respondedBy: 'agent',
            requestedAt: 1, respondedAt: 2, expiresAt: null,
            pluginSnapshotId: 'snapshot-secret', rootPath: 'C:\\secret', grant: { token: 'secret' },
          },
        };
      }
      throw new Error(`unexpected operation ${operation.kind}`);
    });
    const adapter = createHostedRunAdapter(semantic);
    const opaqueValue = {
      owner: 'ordinary document field',
      path: '/ordinary/json/pointer',
      nested: { token: 'ordinary user content' },
    };

    await expect(adapter.dispatch(authority, {
      kind: 'run.genui.respond', runId: 'run-1', surfaceId: 'surface-1',
      body: { value: opaqueValue },
    })).resolves.toEqual({
      ok: true,
      surface: {
        id: 'row-1', projectId: 'project-1', conversationId: 'conversation-1',
        runId: 'run-1', surfaceId: 'surface-1', kind: 'form', persist: 'run',
        value: opaqueValue, status: 'resolved', respondedBy: 'user',
        requestedAt: 1, respondedAt: 2, expiresAt: null,
      },
    });
    expect(semantic.mutations).toHaveLength(1);

    await expect(adapter.dispatch(authority, {
      kind: 'run.genui.respond', runId: 'run-1', surfaceId: 'surface-1',
      body: { value: undefined },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(adapter.dispatch(authority, {
      kind: 'run.genui.respond', runId: 'run-1', surfaceId: 'surface-1',
      body: { value: 'x'.repeat(64 * 1024) },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
