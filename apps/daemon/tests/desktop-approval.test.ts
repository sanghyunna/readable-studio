import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  insertProjectCheckpoint,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import {
  consumeDesktopApprovalToken,
  DesktopApprovalBroker,
  registerDesktopApprovalRoutes,
} from '../src/desktop-approval.js';
import { ProjectCheckpointError } from '../src/project-checkpoints.js';

const TOKEN = 'desktop-approval-test-token';
const AUTH = `Bearer ${TOKEN}`;
const tempDirs: string[] = [];

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DesktopApprovalBroker', () => {
  it('consumes its launch token instead of leaving it in process or child env', () => {
    const env = {
      Path: 'bin',
      ReAdAbLe_Desktop_Approval_Token: TOKEN,
    } as NodeJS.ProcessEnv;
    expect(consumeDesktopApprovalToken(env)).toBe(TOKEN);
    expect(Object.keys(env)).toEqual(['Path']);
  });

  it('fails closed without a desktop token before canceling or mutating', async () => {
    const fixture = seedBroker({ token: null });
    const request = fixture.broker.createAgentRequest(agentRequestInput());

    await expect(fixture.broker.executeAgent(request.requestId, 'overwrite')).rejects.toMatchObject({
      code: 'ROLLBACK_APPROVAL_UNAVAILABLE',
      status: 503,
    });
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.rollback).not.toHaveBeenCalled();
  });

  it('terminates and prepares before approval, then binds the audit id', async () => {
    const fixture = seedBroker();
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const execution = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const approval = (await fixture.broker.nextApproval(AUTH)).approval!;

    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).not.toHaveBeenCalled();
    fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: approval.decisionToken,
    });

    const result = await execution;
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'agent',
      runId: 'run-1',
      targetMessageId: 'assistant-1',
      targetCheckpointId: 'checkpoint-1',
      approvalRequestId: approval.approvalRequestId,
    }));
    expect(result.approvalRequestId).toBe(approval.approvalRequestId);

    expect(() => fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: approval.decisionToken,
    })).not.toThrow();
  });

  it('keeps the exact request executable after its originally active run finishes', async () => {
    const fixture = seedBroker();
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    fixture.run.status = 'succeeded';
    const execution = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const approval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: approval.decisionToken,
    });

    await expect(execution).resolves.toMatchObject({ actor: 'agent' });
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it('rejects denial and tampering without canceling or mutating', async () => {
    const fixture = seedBroker();
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const execution = fixture.broker.executeAgent(request.requestId, 'fail');
    const approval = (await fixture.broker.nextApproval(AUTH)).approval!;

    expect(() => fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: 'wrong-plan-token',
    })).toThrow(expect.objectContaining({ code: 'ROLLBACK_APPROVAL_TAMPERED' }));
    fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: false,
      decisionToken: approval.decisionToken,
    });

    await expect(execution).rejects.toMatchObject({ code: 'ROLLBACK_APPROVAL_DENIED' });
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).not.toHaveBeenCalled();
  });

  it('returns a denied request to available so the user can approve a retry', async () => {
    const fixture = seedBroker();
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const denied = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const firstApproval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, firstApproval.approvalRequestId, {
      approved: false,
      decisionToken: firstApproval.decisionToken,
    });
    await expect(denied).rejects.toMatchObject({ code: 'ROLLBACK_APPROVAL_DENIED' });

    const retry = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const retryApproval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, retryApproval.approvalRequestId, {
      approved: true,
      decisionToken: retryApproval.decisionToken,
    });
    await expect(retry).resolves.toMatchObject({ actor: 'agent' });
  });

  it('rejects duplicate concurrent execution but returns a timed-out request to available', async () => {
    const fixture = seedBroker({ approvalTtlMs: 15 });
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const first = fixture.broker.executeAgent(request.requestId, 'fail');
    await expect(fixture.broker.executeAgent(request.requestId, 'fail')).rejects.toMatchObject({
      code: 'ROLLBACK_REQUEST_CONSUMED',
    });
    await fixture.broker.nextApproval(AUTH);
    await expect(first).rejects.toMatchObject({ code: 'ROLLBACK_APPROVAL_TIMEOUT' });
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.rollback).not.toHaveBeenCalled();

    const retry = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const approval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: approval.decisionToken,
    });
    await expect(retry).resolves.toMatchObject({ actor: 'agent' });
  });

  it('deduplicates each run request and enforces the route scope binding', async () => {
    const fixture = seedBroker();
    const first = fixture.broker.createAgentRequest(agentRequestInput());
    const duplicate = fixture.broker.createAgentRequest(agentRequestInput());
    expect(duplicate.requestId).toBe(first.requestId);

    await expect(fixture.broker.executeAgent(first.requestId, 'fail', {
      projectId: 'different-project',
      conversationId: 'conversation-1',
    })).rejects.toMatchObject({ code: 'ROLLBACK_REQUEST_DRIFTED' });
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(fixture.rollback).not.toHaveBeenCalled();
  });

  it('rejects expired requests and post-approval project drift before mutation', async () => {
    let now = 1_000;
    const expired = seedBroker({ now: () => now, agentRequestTtlMs: 10 });
    const expiredRequest = expired.broker.createAgentRequest(agentRequestInput());
    now += 11;
    await expect(expired.broker.executeAgent(expiredRequest.requestId)).rejects.toMatchObject({
      code: 'ROLLBACK_REQUEST_EXPIRED',
    });

    const drifted = seedBroker();
    const request = drifted.broker.createAgentRequest(agentRequestInput());
    const execution = drifted.broker.executeAgent(request.requestId, 'overwrite');
    const approval = (await drifted.broker.nextApproval(AUTH)).approval!;
    drifted.fileState.version = 2;
    drifted.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: approval.decisionToken,
    });
    await expect(execution).rejects.toMatchObject({ code: 'ROLLBACK_PLAN_CHANGED' });
    expect(drifted.cancel).toHaveBeenCalledTimes(1);
    expect(drifted.rollback).toHaveBeenCalledTimes(1);

    drifted.fileState.version = 1;
    const retry = drifted.broker.executeAgent(request.requestId, 'overwrite');
    const retryApproval = (await drifted.broker.nextApproval(AUTH)).approval!;
    drifted.broker.decide(AUTH, retryApproval.approvalRequestId, {
      approved: true,
      decisionToken: retryApproval.decisionToken,
    });
    await expect(retry).resolves.toMatchObject({ actor: 'agent' });
  });

  it('waits for bounded run termination, fails closed on timeout, and permits retry', async () => {
    const fixture = seedBroker({ terminationResults: [false, true] });
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const first = fixture.broker.executeAgent(request.requestId, 'overwrite');
    await expect(first).rejects.toMatchObject({ code: 'ROLLBACK_RUN_TERMINATION_TIMEOUT' });
    expect(fixture.rollback).not.toHaveBeenCalled();

    const retry = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const retryApproval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, retryApproval.approvalRequestId, {
      approved: true,
      decisionToken: retryApproval.decisionToken,
    });
    await expect(retry).resolves.toMatchObject({ actor: 'agent' });
    expect(fixture.cancelAndWait).toHaveBeenCalledTimes(2);
  });

  it('returns a pre-mutation conflict to available for an overwrite retry', async () => {
    const fixture = seedBroker({
      rollbackErrors: [new ProjectCheckpointError(409, 'ROLLBACK_CONFLICT', 'conflict')],
    });
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const first = fixture.broker.executeAgent(request.requestId, 'fail');
    const firstApproval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, firstApproval.approvalRequestId, {
      approved: true,
      decisionToken: firstApproval.decisionToken,
    });
    await expect(first).rejects.toMatchObject({ code: 'ROLLBACK_CONFLICT' });

    const retry = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const retryApproval = (await fixture.broker.nextApproval(AUTH)).approval!;
    fixture.broker.decide(AUTH, retryApproval.approvalRequestId, {
      approved: true,
      decisionToken: retryApproval.decisionToken,
    });
    await expect(retry).resolves.toMatchObject({ actor: 'agent' });
  });

  it('prepares the approved revision only after the run has terminated', async () => {
    const order: string[] = [];
    const fixture = seedBroker({
      onCancelAndWait: async () => {
        order.push('terminated');
        return true;
      },
      onDiff: () => order.push('fingerprint'),
      onRollback: () => order.push('rollback'),
    });
    const request = fixture.broker.createAgentRequest(agentRequestInput());
    const execution = fixture.broker.executeAgent(request.requestId, 'overwrite');
    const approval = (await fixture.broker.nextApproval(AUTH)).approval!;
    expect(order).toEqual(['terminated', 'fingerprint']);
    fixture.broker.decide(AUTH, approval.approvalRequestId, {
      approved: true,
      decisionToken: approval.decisionToken,
    });
    await execution;
    expect(order).toEqual(['terminated', 'fingerprint', 'rollback']);
  });

  it('authenticates both private HTTP routes', async () => {
    const fixture = seedBroker();
    const app = express();
    app.use(express.json());
    registerDesktopApprovalRoutes(app, fixture.broker, (res, error: any) => {
      res.status(error?.status ?? 500).json({ error: { code: error?.code ?? 'INTERNAL_ERROR' } });
    });
    const server = await listen(app);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      const next = await fetch(`${baseUrl}/api/desktop/rollback-approvals/next`);
      expect(next.status).toBe(401);
      expect(await next.json()).toMatchObject({ error: { code: 'ROLLBACK_APPROVAL_UNAUTHORIZED' } });

      const decision = await fetch(`${baseUrl}/api/desktop/rollback-approvals/missing/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ approved: true, decisionToken: 'x' }),
      });
      expect(decision.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function seedBroker(options: {
  token?: string | null;
  now?: () => number;
  agentRequestTtlMs?: number;
  approvalTtlMs?: number;
  terminationResults?: boolean[];
  onCancelAndWait?: () => Promise<boolean>;
  onDiff?: () => void;
  onRollback?: () => void;
  rollbackErrors?: Error[];
} = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'readable-desktop-approval-'));
  tempDirs.push(tempDir);
  const db = openDatabase(tempDir, { dataDir: tempDir });
  const createdAt = 100;
  insertProject(db, { id: 'project-1', name: 'Project', createdAt, updatedAt: createdAt });
  insertConversation(db, {
    id: 'conversation-1',
    projectId: 'project-1',
    title: 'Conversation',
    createdAt,
    updatedAt: createdAt,
  });
  upsertMessage(db, 'conversation-1', {
    id: 'assistant-1',
    role: 'assistant',
    content: 'work',
    runId: 'run-1',
    runStatus: 'running',
    createdAt,
  });
  insertProjectCheckpoint(db, {
    id: 'checkpoint-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    messageId: 'assistant-1',
    runId: 'run-1',
    kind: 'before_run',
    rootPathHash: 'root-hash',
    manifestPath: 'checkpoints/checkpoint-1/manifest.json',
    manifestHash: 'manifest-hash',
    fileCount: 1,
    totalBytes: 4,
    createdAt,
  });

  const run = {
    id: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    assistantMessageId: 'assistant-1',
    status: 'running',
  };
  const cancel = vi.fn(() => {
    run.status = 'canceled';
  });
  const terminationResults = [...(options.terminationResults ?? [true])];
  const cancelAndWait = vi.fn(async () => {
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'canceled') return true;
    const stopped = options.onCancelAndWait
      ? await options.onCancelAndWait()
      : (terminationResults.shift() ?? true);
    if (stopped) cancel();
    return stopped;
  });
  const design = {
    runs: {
      get: (id: string) => id === run.id ? run : null,
      list: ({ projectId, conversationId, status }: any = {}) => {
        if (projectId && projectId !== run.projectId) return [];
        if (conversationId && conversationId !== run.conversationId) return [];
        if (status === 'active' && run.status === 'canceled') return [];
        return [run];
      },
      cancel,
      cancelAndWait,
    },
  };
  const fileState = { version: 1 };
  const rollback = vi.fn(async (input: any) => {
    options.onRollback?.();
    const rollbackError = options.rollbackErrors?.shift();
    if (rollbackError) throw rollbackError;
    if (input.expectedRevision !== String(fileState.version).padStart(64, '0')) {
      throw new ProjectCheckpointError(409, 'ROLLBACK_PLAN_CHANGED', 'plan changed');
    }
    return {
      projectId: input.projectId,
      conversationId: input.conversationId,
      mode: input.mode,
      targetMessageId: input.targetMessageId,
      restoredCheckpointId: input.targetCheckpointId,
      safetyCheckpointId: 'safety-1',
      deletedMessageIds: [],
      clearedAgentSessions: false,
      fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
      conflicts: [],
      actor: input.actor,
      approvalRequestId: input.approvalRequestId,
    };
  });
  const checkpoints = {
    getCheckpoint: () => ({
      id: 'checkpoint-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      messageId: 'assistant-1',
      runId: 'run-1',
      kind: 'before_run',
      createdAt,
      rootPathHash: 'root-hash',
      fileCount: 1,
      totalBytes: 4,
      manifestHash: 'manifest-hash',
      restoreModes: ['files_only'],
    }),
    prepareAgentRollback: async () => {
      options.onDiff?.();
      return {
        targetCheckpointId: 'checkpoint-1',
        revision: String(fileState.version).padStart(64, '0'),
        fileChanges: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
        conflicts: [],
      };
    },
    rollback,
  } as any;

  const broker = new DesktopApprovalBroker({
    db,
    design,
    checkpoints,
    token: options.token === undefined ? TOKEN : options.token,
    ...(options.now ? { now: options.now } : {}),
    ...(options.agentRequestTtlMs === undefined ? {} : { agentRequestTtlMs: options.agentRequestTtlMs }),
    ...(options.approvalTtlMs === undefined ? {} : { approvalTtlMs: options.approvalTtlMs }),
    longPollMs: 5,
  });
  return { broker, cancel, cancelAndWait, rollback, fileState, run };
}

function agentRequestInput() {
  return {
    projectId: 'project-1',
    conversationId: 'conversation-1',
    runId: 'run-1',
    mode: 'files_only' as const,
    reason: 'undo the bad edit',
  };
}

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}
