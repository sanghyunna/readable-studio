import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type {
  AgentRollbackRequestEvent,
  DesktopRollbackApprovalDecisionRequest,
  DesktopRollbackApprovalNextResponse,
  DesktopRollbackApprovalPlan,
  RollbackConflictPolicy,
  RollbackMode,
  RollbackResponse,
} from '@readable-studio/contracts';
import { SIDECAR_ENV } from '@readable-studio/sidecar-proto';
import {
  findProjectCheckpointForMessage,
  getConversation,
  getMessagePosition,
} from './db.js';
import {
  ProjectCheckpointError,
  type ProjectCheckpointService,
} from './project-checkpoints.js';

const AGENT_REQUEST_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 2 * 60_000;
const APPROVAL_LONG_POLL_MS = 25_000;
const RUN_TERMINATION_TIMEOUT_MS = 5_000;
const MAX_REASON_LENGTH = 2_000;

type Clock = () => number;

interface AgentRequestBinding {
  runId: string;
  projectId: string;
  conversationId: string;
  targetMessageId: string;
  targetCheckpointId: string;
  mode: 'files_only';
  reason: string;
}

interface StoredAgentRequest extends AgentRequestBinding {
  requestId: string;
  expiresAt: number;
  retainUntil: number;
  state: 'available' | 'in_flight' | 'consumed';
}

interface PendingApproval {
  plan: DesktopRollbackApprovalPlan;
  decisionToken: string;
  delivered: boolean;
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConsumedApproval {
  approved: boolean | null;
  decisionToken: string | null;
  expiresAt: number;
}

export interface DesktopApprovalBrokerOptions {
  db: any;
  design: any;
  checkpoints: ProjectCheckpointService;
  token: string | null;
  now?: Clock;
  agentRequestTtlMs?: number;
  approvalTtlMs?: number;
  longPollMs?: number;
}

export class DesktopApprovalError extends ProjectCheckpointError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = 'DesktopApprovalError';
  }
}

/**
 * Remove the desktop-only bearer from the daemon environment before any
 * child process can inherit it. Matching is case-insensitive for Windows.
 */
export function consumeDesktopApprovalToken(env: NodeJS.ProcessEnv): string | null {
  let token: string | null = null;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN) continue;
    const value = env[key]?.trim();
    if (token === null && value) token = value;
    delete env[key];
  }
  return token;
}

/** Strip a desktop approval bearer from a child environment. */
export function stripDesktopApprovalToken(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === SIDECAR_ENV.DESKTOP_APPROVAL_TOKEN) delete env[key];
  }
}

export class DesktopApprovalBroker {
  private readonly db: any;
  private readonly design: any;
  private readonly checkpoints: ProjectCheckpointService;
  private readonly token: string | null;
  private readonly now: Clock;
  private readonly agentRequestTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly longPollMs: number;
  private readonly agentRequests = new Map<string, StoredAgentRequest>();
  private readonly agentRequestByRun = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly approvalQueue: string[] = [];
  private readonly consumedApprovals = new Map<string, ConsumedApproval>();
  private readonly queueWaiters = new Set<() => void>();

  constructor(options: DesktopApprovalBrokerOptions) {
    this.db = options.db;
    this.design = options.design;
    this.checkpoints = options.checkpoints;
    this.token = options.token;
    this.now = options.now ?? Date.now;
    this.agentRequestTtlMs = options.agentRequestTtlMs ?? AGENT_REQUEST_TTL_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? APPROVAL_TTL_MS;
    this.longPollMs = options.longPollMs ?? APPROVAL_LONG_POLL_MS;
  }

  createAgentRequest(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    mode: RollbackMode;
    reason?: string;
  }): AgentRollbackRequestEvent {
    this.pruneAgentRequests();
    const binding = this.resolveAgentBinding(input);
    const priorId = this.agentRequestByRun.get(binding.runId);
    const prior = priorId ? this.agentRequests.get(priorId) : null;
    if (prior && prior.retainUntil > this.now()) return publicAgentRequest(prior);
    if (priorId) {
      this.agentRequestByRun.delete(binding.runId);
      this.agentRequests.delete(priorId);
    }
    const requestId = randomUUID();
    const expiresAt = this.now() + this.agentRequestTtlMs;
    const request = { ...binding, requestId, expiresAt, retainUntil: expiresAt, state: 'available' as const };
    this.agentRequests.set(requestId, request);
    this.agentRequestByRun.set(binding.runId, requestId);
    return publicAgentRequest(request);
  }

  async executeAgent(
    requestId: string,
    conflictPolicy: RollbackConflictPolicy = 'fail',
    scope?: { projectId: string; conversationId: string },
  ): Promise<RollbackResponse> {
    this.requireAvailable();
    assertConflictPolicy(conflictPolicy);
    const request = this.claimAgentRequest(requestId);
    try {
      if (
        scope
        && (request.projectId !== scope.projectId || request.conversationId !== scope.conversationId)
      ) {
        throw drifted();
      }
      const current = this.resolveAgentBinding(request, false);
      if (!sameAgentBinding(request, current)) {
        throw drifted();
      }
      const run = this.design.runs?.get?.(request.runId);
      if (run && !isTerminalRunStatus(run.status)) await this.cancelAndWait(run);
      const afterCancel = this.resolveAgentBinding(request, false);
      if (!sameAgentBinding(request, afterCancel)) throw drifted();
      const prepared = await this.checkpoints.prepareAgentRollback({
        projectId: request.projectId,
        conversationId: request.conversationId,
        targetMessageId: request.targetMessageId,
        targetCheckpointId: request.targetCheckpointId,
        runId: request.runId,
      });
      const approvalRequestId = randomUUID();
      const approved = await this.requestApproval({
        actor: 'agent',
        projectId: request.projectId,
        conversationId: request.conversationId,
        targetMessageId: request.targetMessageId,
        targetCheckpointId: prepared.targetCheckpointId,
        mode: 'files_only',
        conflictPolicy,
        runId: request.runId,
        revision: prepared.revision,
        fileChanges: prepared.fileChanges,
        conflictCount: prepared.conflicts.length,
        reason: request.reason,
        approvalRequestId,
        expiresAt: this.now() + this.approvalTtlMs,
      });
      if (!approved) {
        throw new DesktopApprovalError(403, 'ROLLBACK_APPROVAL_DENIED', 'rollback approval was denied');
      }
      const result = await this.checkpoints.rollback({
        projectId: request.projectId,
        conversationId: request.conversationId,
        targetMessageId: request.targetMessageId,
        targetCheckpointId: prepared.targetCheckpointId,
        mode: 'files_only',
        conflictPolicy,
        createSafetyCheckpoint: true,
        runId: request.runId,
        actor: 'agent',
        approvalRequestId,
        expectedRevision: prepared.revision,
      });
      request.state = 'consumed';
      return result;
    } catch (error) {
      if (request.state === 'in_flight' || isRetryableRollbackFailure(error)) {
        request.state = 'available';
      }
      throw error;
    }
  }

  async nextApproval(
    authorization: string | undefined,
    signal?: AbortSignal,
  ): Promise<DesktopRollbackApprovalNextResponse> {
    this.authorize(authorization);
    const immediate = this.takeQueuedApproval();
    if (immediate) return { approval: immediate };
    await this.waitForQueuedApproval(signal);
    return { approval: this.takeQueuedApproval() };
  }

  decide(
    authorization: string | undefined,
    approvalRequestId: string,
    decision: DesktopRollbackApprovalDecisionRequest,
  ): void {
    this.authorize(authorization);
    this.pruneConsumed();
    const pending = this.approvals.get(approvalRequestId);
    if (!pending) {
      const consumed = this.consumedApprovals.get(approvalRequestId);
      if (consumed) {
        if (
          consumed.approved === decision.approved
          && consumed.decisionToken !== null
          && safeEqual(consumed.decisionToken, decision.decisionToken)
        ) return;
        throw new DesktopApprovalError(409, 'ROLLBACK_APPROVAL_CONSUMED', 'rollback approval was already consumed');
      }
      throw new DesktopApprovalError(404, 'ROLLBACK_APPROVAL_NOT_FOUND', 'rollback approval not found');
    }
    if (!safeEqual(pending.decisionToken, decision.decisionToken)) {
      throw new DesktopApprovalError(409, 'ROLLBACK_APPROVAL_TAMPERED', 'rollback approval decision does not match the pending plan');
    }
    this.consumeApproval(pending, decision);
    pending.resolve(decision.approved);
  }

  private requireAvailable(): void {
    if (!this.token) {
      throw new DesktopApprovalError(
        503,
        'ROLLBACK_APPROVAL_UNAVAILABLE',
        'trusted desktop rollback approval is unavailable',
      );
    }
  }

  private authorize(authorization: string | undefined): void {
    this.requireAvailable();
    const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '');
    if (!match || !safeEqual(this.token!, match[1]!)) {
      throw new DesktopApprovalError(401, 'ROLLBACK_APPROVAL_UNAUTHORIZED', 'desktop rollback approval bearer is invalid');
    }
  }

  private claimAgentRequest(requestId: string): StoredAgentRequest {
    const request = this.agentRequests.get(requestId);
    if (!request) {
      throw new DesktopApprovalError(404, 'ROLLBACK_REQUEST_NOT_FOUND', 'agent rollback request not found');
    }
    if (request.expiresAt <= this.now()) {
      this.agentRequests.delete(requestId);
      if (this.agentRequestByRun.get(request.runId) === requestId) {
        this.agentRequestByRun.delete(request.runId);
      }
      throw new DesktopApprovalError(410, 'ROLLBACK_REQUEST_EXPIRED', 'agent rollback request expired');
    }
    if (request.state !== 'available') {
      throw new DesktopApprovalError(409, 'ROLLBACK_REQUEST_CONSUMED', 'agent rollback request was already consumed');
    }
    request.state = 'in_flight';
    request.retainUntil = Math.max(request.retainUntil, this.now() + this.approvalTtlMs);
    return request;
  }

  private resolveAgentBinding(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    mode: RollbackMode;
    reason?: string;
  }, requireActive = true): AgentRequestBinding {
    if (input.mode !== 'files_only') {
      throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'agent rollback only supports files_only');
    }
    const conversation = getConversation(this.db, input.conversationId);
    if (!conversation || conversation.projectId !== input.projectId) {
      throw new ProjectCheckpointError(404, 'CONVERSATION_NOT_FOUND', 'conversation not found');
    }
    const activeRun = requireActive
      ? (this.design.runs?.list?.({
          projectId: input.projectId,
          conversationId: input.conversationId,
          status: 'active',
        }) ?? []).find((run: any) => run.id === input.runId)
      : this.design.runs?.get?.(input.runId);
    if (
      !activeRun
      || activeRun.projectId !== input.projectId
      || activeRun.conversationId !== input.conversationId
    ) {
      if (!requireActive) throw drifted();
      throw new ProjectCheckpointError(409, 'RUN_NOT_ACTIVE', 'run is not active');
    }
    const targetMessageId = activeRun.assistantMessageId;
    if (typeof targetMessageId !== 'string' || !getMessagePosition(this.db, input.conversationId, targetMessageId)) {
      throw new ProjectCheckpointError(404, 'MESSAGE_NOT_FOUND', 'assistant message not found');
    }
    const checkpoint = findProjectCheckpointForMessage(this.db, {
      projectId: input.projectId,
      conversationId: input.conversationId,
      messageId: targetMessageId,
      kinds: ['before_run'],
    });
    if (!checkpoint) {
      throw new ProjectCheckpointError(404, 'CHECKPOINT_NOT_FOUND', 'checkpoint not found');
    }
    if (checkpoint.runId !== input.runId) {
      throw new ProjectCheckpointError(403, 'ROLLBACK_RUN_MISMATCH', 'checkpoint does not belong to the specified run');
    }
    return {
      runId: input.runId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      targetMessageId,
      targetCheckpointId: checkpoint.id,
      mode: 'files_only',
      reason: (input.reason ?? '').trim().slice(0, MAX_REASON_LENGTH),
    };
  }

  private async cancelAndWait(run: any): Promise<void> {
    const stopped = typeof this.design.runs?.cancelAndWait === 'function'
      ? await this.design.runs.cancelAndWait(run, { timeoutMs: RUN_TERMINATION_TIMEOUT_MS })
      : (this.design.runs?.cancel?.(run), isTerminalRunStatus(run.status));
    if (!stopped) {
      throw new DesktopApprovalError(
        503,
        'ROLLBACK_RUN_TERMINATION_TIMEOUT',
        'target run did not terminate before the rollback deadline',
      );
    }
  }

  private requestApproval(plan: DesktopRollbackApprovalPlan): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const pending: PendingApproval = {
        plan,
        decisionToken: randomBytes(32).toString('base64url'),
        delivered: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!this.approvals.has(plan.approvalRequestId)) return;
          this.consumeApproval(pending);
          reject(new DesktopApprovalError(408, 'ROLLBACK_APPROVAL_TIMEOUT', 'rollback approval timed out'));
        }, Math.max(0, plan.expiresAt - this.now())),
      };
      pending.timer.unref?.();
      this.approvals.set(plan.approvalRequestId, pending);
      this.approvalQueue.push(plan.approvalRequestId);
      for (const wake of this.queueWaiters) wake();
      this.queueWaiters.clear();
    });
  }

  private takeQueuedApproval(): DesktopRollbackApprovalNextResponse['approval'] {
    while (this.approvalQueue.length > 0) {
      const id = this.approvalQueue.shift()!;
      const pending = this.approvals.get(id);
      if (!pending || pending.delivered) continue;
      pending.delivered = true;
      return { ...pending.plan, decisionToken: pending.decisionToken };
    }
    return null;
  }

  private waitForQueuedApproval(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.queueWaiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.longPollMs);
      timer.unref?.();
      this.queueWaiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private consumeApproval(
    pending: PendingApproval,
    decision?: DesktopRollbackApprovalDecisionRequest,
  ): void {
    clearTimeout(pending.timer);
    this.approvals.delete(pending.plan.approvalRequestId);
    this.consumedApprovals.set(pending.plan.approvalRequestId, {
      approved: decision?.approved ?? null,
      decisionToken: decision?.decisionToken ?? null,
      expiresAt: this.now() + this.approvalTtlMs,
    });
  }

  private pruneConsumed(): void {
    const now = this.now();
    for (const [id, consumed] of this.consumedApprovals) {
      if (consumed.expiresAt <= now) this.consumedApprovals.delete(id);
    }
  }

  private pruneAgentRequests(): void {
    const now = this.now();
    for (const [id, request] of this.agentRequests) {
      if (request.retainUntil > now) continue;
      this.agentRequests.delete(id);
      if (this.agentRequestByRun.get(request.runId) === id) {
        this.agentRequestByRun.delete(request.runId);
      }
    }
  }
}

export function registerDesktopApprovalRoutes(
  app: Express,
  broker: DesktopApprovalBroker,
  sendError: (res: Response, error: unknown) => void,
): void {
  app.get('/api/desktop/rollback-approvals/next', async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      res.json(await broker.nextApproval(req.get('authorization'), abort.signal));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/desktop/rollback-approvals/:id/decision', (req: Request, res: Response) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (
      Object.keys(body).some((key) => key !== 'approved' && key !== 'decisionToken')
      || typeof body.approved !== 'boolean'
      || typeof body.decisionToken !== 'string'
      || !body.decisionToken
    ) {
      return sendError(res, new ProjectCheckpointError(400, 'BAD_REQUEST', 'approved and decisionToken are required'));
    }
    try {
      broker.decide(
        req.get('authorization'),
        String(req.params.id ?? ''),
        body as DesktopRollbackApprovalDecisionRequest,
      );
      res.json({ accepted: true });
    } catch (error) {
      sendError(res, error);
    }
  });
}

function safeEqual(left: string, right: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}

function sameAgentBinding(left: AgentRequestBinding, right: AgentRequestBinding): boolean {
  return left.runId === right.runId
    && left.projectId === right.projectId
    && left.conversationId === right.conversationId
    && left.targetMessageId === right.targetMessageId
    && left.targetCheckpointId === right.targetCheckpointId
    && left.mode === right.mode;
}

function publicAgentRequest(request: StoredAgentRequest): AgentRollbackRequestEvent {
  const { state: _state, retainUntil: _retainUntil, ...payload } = request;
  return { kind: 'agent_rollback_request', ...payload };
}

function drifted(): DesktopApprovalError {
  return new DesktopApprovalError(409, 'ROLLBACK_REQUEST_DRIFTED', 'rollback target changed after the request was created');
}

function assertConflictPolicy(value: unknown): asserts value is RollbackConflictPolicy {
  if (value !== 'fail' && value !== 'overwrite' && value !== 'keep_current') {
    throw new ProjectCheckpointError(400, 'BAD_REQUEST', 'invalid rollback conflict policy');
  }
}

function isTerminalRunStatus(status: unknown): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function isRetryableRollbackFailure(error: unknown): boolean {
  return error instanceof ProjectCheckpointError
    && (error.code === 'ROLLBACK_CONFLICT' || error.code === 'ROLLBACK_PLAN_CHANGED');
}
