import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { NormalizedHostedRunIntentV1 } from './hosted-run-adapter.js';
import { isSafeId } from './projects.js';

export const HOSTED_RUN_RECEIPT_LIMITS = Object.freeze({ maxReceipts: 2_000 });

export type HostedRunReceiptRouteKind = 'runs' | 'chat';
export type HostedRunReceiptStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export interface HostedRunReceiptResult {
  readonly runId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
}

export interface HostedRunReceipt {
  readonly clientRequestId: string;
  readonly digest: string;
  readonly routeKind: HostedRunReceiptRouteKind;
  readonly result: HostedRunReceiptResult;
  readonly status: HostedRunReceiptStatus;
  readonly resumable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class HostedRunReceiptError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code:
      | 'BAD_REQUEST'
      | 'CONFLICT'
      | 'HOSTED_CAPACITY_EXHAUSTED'
      | 'INTERNAL_ERROR'
      | 'RETRY_KEY_REUSED',
    message: string,
  ) {
    super(message);
    this.name = 'HostedRunReceiptError';
    this.statusCode = code === 'RETRY_KEY_REUSED' || code === 'CONFLICT'
      ? 409
      : code === 'HOSTED_CAPACITY_EXHAUSTED'
        ? 503
        : code === 'BAD_REQUEST'
          ? 400
          : 500;
  }
}

export interface HostedRunReceiptStore {
  accept(input: {
    readonly routeKind: HostedRunReceiptRouteKind;
    readonly intent: NormalizedHostedRunIntentV1;
    readonly result: HostedRunReceiptResult;
  }): { readonly existing: boolean; readonly receipt: HostedRunReceipt };
  count(): number;
  get(clientRequestId: string): HostedRunReceipt | null;
  list(): readonly HostedRunReceipt[];
  reconcileInterrupted(): number;
  updateStatus(
    clientRequestId: string,
    status: HostedRunReceiptStatus,
    options?: { readonly resumable?: boolean },
  ): HostedRunReceipt | null;
}

interface ReceiptRow {
  assistant_message_id: string;
  client_request_id: string;
  conversation_id: string;
  created_at: number;
  digest: string;
  resumable: number;
  route_kind: string;
  run_id: string;
  status: string;
  updated_at: number;
}

const RECEIPT_STATUSES = new Set<HostedRunReceiptStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
]);

/**
 * Hash the closed, normalized intent shape. The property order below is the
 * RFC 8785 lexicographic order; every nested value is a JSON primitive or an
 * ordered string array, so native JSON string serialization is canonical.
 */
export function digestHostedRunIntent(
  routeKind: HostedRunReceiptRouteKind,
  intent: NormalizedHostedRunIntentV1,
): string {
  if (routeKind !== 'runs' && routeKind !== 'chat') throw badRequest('hosted run route kind is invalid');
  const canonical = {
    agentId: intent.agentId,
    assistantMessageId: intent.assistantMessageId,
    attachmentIds: intent.attachmentIds,
    commentAttachmentIds: intent.commentAttachmentIds,
    contextSelectionIds: intent.contextSelectionIds,
    conversationId: intent.conversationId,
    currentPrompt: intent.currentPrompt,
    designSystemId: intent.designSystemId,
    locale: intent.locale,
    message: intent.message,
    model: intent.model,
    projectId: intent.projectId,
    reasoning: intent.reasoning,
    routeKind,
    sessionMode: intent.sessionMode,
    skillIds: intent.skillIds,
    version: 'hosted-run-intent-v1',
  };
  assertCanonicalIntent(canonical);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function createHostedRunReceiptStore(
  database: Database.Database,
  options: {
    readonly maxReceipts?: number;
    readonly now?: () => number;
  } = {},
): HostedRunReceiptStore {
  const maxReceipts = boundedMaxReceipts(options.maxReceipts);
  const now = options.now ?? Date.now;
  migrate(database);

  const select = database.prepare(`
    SELECT client_request_id, digest, route_kind, run_id, conversation_id,
           assistant_message_id, status, resumable, created_at, updated_at
      FROM hosted_run_receipts
     WHERE client_request_id = ?
  `);
  const count = database.prepare('SELECT COUNT(*) AS count FROM hosted_run_receipts');
  const list = database.prepare(`
    SELECT client_request_id, digest, route_kind, run_id, conversation_id,
           assistant_message_id, status, resumable, created_at, updated_at
      FROM hosted_run_receipts
     ORDER BY created_at ASC, client_request_id ASC
  `);
  const insert = database.prepare(`
    INSERT INTO hosted_run_receipts (
      client_request_id, digest, route_kind, run_id, conversation_id,
      assistant_message_id, status, resumable, created_at, updated_at
    ) VALUES (
      @clientRequestId, @digest, @routeKind, @runId, @conversationId,
      @assistantMessageId, 'queued', 0, @now, @now
    )
  `);
  const update = database.prepare(`
    UPDATE hosted_run_receipts
       SET status = @status,
           resumable = COALESCE(@resumable, resumable),
           updated_at = @now
     WHERE client_request_id = @clientRequestId
  `);
  const interruptActive = database.prepare(`
    UPDATE hosted_run_receipts
       SET status = 'interrupted', resumable = 1, updated_at = ?
     WHERE status IN ('queued', 'running')
  `);

  const acceptTransaction = database.transaction((input: {
    readonly routeKind: HostedRunReceiptRouteKind;
    readonly intent: NormalizedHostedRunIntentV1;
    readonly result: HostedRunReceiptResult;
  }) => {
    const clientRequestId = validClientRequestId(input.intent.clientRequestId);
    const digest = digestHostedRunIntent(input.routeKind, input.intent);
    const existing = readReceipt(select.get(clientRequestId));
    if (existing != null) {
      if (existing.digest !== digest) {
        throw new HostedRunReceiptError(
          'RETRY_KEY_REUSED',
          'clientRequestId was already accepted for a different run intent',
        );
      }
      return { existing: true as const, receipt: existing };
    }

    const result = validResult(input.result, input.intent);
    if (readCount(count.get()) >= maxReceipts) {
      throw new HostedRunReceiptError(
        'HOSTED_CAPACITY_EXHAUSTED',
        'hosted run receipt capacity is exhausted',
      );
    }
    const timestamp = validTimestamp(now());
    insert.run({
      clientRequestId,
      digest,
      routeKind: input.routeKind,
      ...result,
      now: timestamp,
    });
    const receipt = readReceipt(select.get(clientRequestId));
    if (receipt == null) throw internalError('hosted run receipt insert was not observable');
    return { existing: false as const, receipt };
  });
  const updateStatusTransaction = database.transaction((input: {
    readonly clientRequestId: string;
    readonly resumable?: boolean;
    readonly status: HostedRunReceiptStatus;
  }) => {
    const clientRequestId = validClientRequestId(input.clientRequestId);
    const existing = readReceipt(select.get(clientRequestId));
    if (existing == null) return null;
    const resumable = input.status === 'interrupted';
    if (input.resumable !== undefined && input.resumable !== resumable) {
      throw badRequest('hosted run receipt resumable flag conflicts with status');
    }
    if (!validStatusTransition(existing.status, input.status)) {
      throw new HostedRunReceiptError(
        'CONFLICT',
        'hosted run receipt status cannot move backward or change terminal state',
      );
    }
    update.run({
      clientRequestId,
      status: input.status,
      resumable: Number(resumable),
      now: validTimestamp(now()),
    });
    return readReceipt(select.get(clientRequestId));
  });

  return {
    accept: acceptTransaction,
    count() {
      return readCount(count.get());
    },
    get(clientRequestId) {
      return readReceipt(select.get(validClientRequestId(clientRequestId)));
    },
    list() {
      return Object.freeze(list.all().map((row) => {
        const receipt = readReceipt(row);
        if (receipt == null) throw internalError('hosted run receipt list is invalid');
        return receipt;
      }));
    },
    reconcileInterrupted() {
      return interruptActive.run(validTimestamp(now())).changes;
    },
    updateStatus(clientRequestId, status, updateOptions = {}) {
      if (!RECEIPT_STATUSES.has(status)) throw badRequest('hosted run receipt status is invalid');
      if (updateOptions.resumable !== undefined && typeof updateOptions.resumable !== 'boolean') {
        throw badRequest('hosted run receipt resumable flag is invalid');
      }
      return updateStatusTransaction({
        clientRequestId,
        status,
        ...updateOptions,
      });
    },
  };
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS hosted_run_receipts (
      client_request_id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      route_kind TEXT NOT NULL CHECK(route_kind IN ('runs', 'chat')),
      run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'
      )),
      resumable INTEGER NOT NULL DEFAULT 0 CHECK(resumable IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;

  `);
}

function assertCanonicalIntent(input: Record<string, unknown>): void {
  const stringFields = [
    'agentId',
    'assistantMessageId',
    'conversationId',
    'currentPrompt',
    'locale',
    'message',
    'projectId',
  ];
  const arrayFields = [
    'attachmentIds',
    'commentAttachmentIds',
    'contextSelectionIds',
    'skillIds',
  ];
  if (
    stringFields.some((field) => typeof input[field] !== 'string')
    || arrayFields.some((field) => !Array.isArray(input[field])
      || (input[field] as unknown[]).some((entry) => typeof entry !== 'string'))
    || !['design', 'chat'].includes(String(input.sessionMode))
    || !nullableString(input.designSystemId)
    || !nullableString(input.model)
    || !nullableString(input.reasoning)
  ) throw badRequest('hosted run intent is not normalized');
}

function nullableString(input: unknown): boolean {
  return input === null || typeof input === 'string';
}

function validStatusTransition(
  current: HostedRunReceiptStatus,
  next: HostedRunReceiptStatus,
): boolean {
  if (current === next) return true;
  if (current === 'queued') return true;
  if (current === 'running') return !['queued', 'running'].includes(next);
  return false;
}

function validClientRequestId(input: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input)) {
    throw badRequest('clientRequestId is invalid');
  }
  return input;
}

function validResult(
  input: HostedRunReceiptResult,
  intent: NormalizedHostedRunIntentV1,
): HostedRunReceiptResult {
  if (
    input == null
    || typeof input !== 'object'
    || !isSafeId(input.runId)
    || !isSafeId(input.conversationId)
    || !isSafeId(input.assistantMessageId)
    || input.conversationId !== intent.conversationId
    || input.assistantMessageId !== intent.assistantMessageId
  ) throw badRequest('hosted run receipt result is invalid');
  return {
    runId: input.runId,
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
  };
}

function readReceipt(input: unknown): HostedRunReceipt | null {
  if (input == null) return null;
  const row = input as ReceiptRow;
  if (
    !validStoredId(row.client_request_id, true)
    || !/^[a-f0-9]{64}$/u.test(row.digest)
    || (row.route_kind !== 'runs' && row.route_kind !== 'chat')
    || !validStoredId(row.run_id)
    || !validStoredId(row.conversation_id)
    || !validStoredId(row.assistant_message_id)
    || !RECEIPT_STATUSES.has(row.status as HostedRunReceiptStatus)
    || (row.resumable !== 0 && row.resumable !== 1)
    || (row.resumable === 1) !== (row.status === 'interrupted')
    || !Number.isSafeInteger(row.created_at)
    || row.created_at < 0
    || !Number.isSafeInteger(row.updated_at)
    || row.updated_at < 0
  ) throw internalError('hosted run receipt storage is invalid');
  return {
    clientRequestId: row.client_request_id,
    digest: row.digest,
    routeKind: row.route_kind,
    result: {
      runId: row.run_id,
      conversationId: row.conversation_id,
      assistantMessageId: row.assistant_message_id,
    },
    status: row.status as HostedRunReceiptStatus,
    resumable: row.resumable === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validStoredId(input: unknown, retryKey = false): input is string {
  return retryKey
    ? typeof input === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(input)
    : isSafeId(input);
}

function readCount(input: unknown): number {
  const value = (input as { count?: unknown } | undefined)?.count;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw internalError('hosted run receipt count is invalid');
  }
  return value as number;
}

function boundedMaxReceipts(input: number | undefined): number {
  if (input === undefined) return HOSTED_RUN_RECEIPT_LIMITS.maxReceipts;
  if (!Number.isSafeInteger(input) || input < 1) throw new Error('maxReceipts must be positive');
  return Math.min(input, HOSTED_RUN_RECEIPT_LIMITS.maxReceipts);
}

function validTimestamp(input: number): number {
  if (!Number.isSafeInteger(input) || input < 0) throw internalError('hosted run receipt clock is invalid');
  return input;
}

function badRequest(message: string): HostedRunReceiptError {
  return new HostedRunReceiptError('BAD_REQUEST', message);
}

function internalError(message: string): HostedRunReceiptError {
  return new HostedRunReceiptError('INTERNAL_ERROR', message);
}
