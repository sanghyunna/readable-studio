import {
  API_ERROR_CODES,
  HOSTED_AG_UI_EVENT_KINDS,
  HOSTED_GEN_UI_SURFACE_KINDS,
  HOSTED_RUN_STATUSES,
  type HostedAgUiEvent,
  type HostedGenUiRespondResponse,
  type HostedGenUiRevokeResponse,
  type HostedGenUiSurface,
  type HostedGenUiSurfaceResponse,
  type HostedProjectGenUiResponse,
  type HostedRunCancelResponse,
  type HostedRunCreateResponse,
  type HostedRunFeedbackRequest,
  type HostedRunFeedbackResponse,
  type HostedRunGenUiResponse,
  type HostedRunIntentV1,
  type HostedRunListResponse,
  type HostedRunStatus,
  type HostedRunStatusResponse,
  type JsonValue,
} from '@readable-studio/contracts';

import { isSafeId } from './projects.js';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_GEN_UI_VALUE_BYTES = 64 * 1024;
const MAX_FEEDBACK_REASON_BYTES = 2 * 1024;
const MAX_SURFACES = 2_000;
const MAX_RUNS = 2_000;
const MAX_AG_UI_EVENTS = 2_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

const FEEDBACK_REASONS = new Set([
  'matched_request',
  'strong_visual',
  'useful_structure',
  'easy_to_continue',
  'followed_design_system',
  'missed_request',
  'weak_visual',
  'incomplete_output',
  'hard_to_use',
  'missed_design_system',
  'other',
]);

const GEN_UI_PERSIST_TIERS = new Set(['run', 'conversation', 'project']);
const GEN_UI_STATUSES = new Set(['pending', 'resolved', 'timeout', 'invalidated']);
const GEN_UI_RESPONDERS = new Set(['user', 'agent', 'auto', 'cache']);
const FEEDBACK_RESULTS = new Set(['accepted', 'skipped_consent', 'skipped_no_sink']);

export interface HostedRunAuthority {
  readonly userKey: string;
  readonly generation: number;
}

export interface NormalizedHostedRunIntentV1 extends HostedRunIntentV1 {
  readonly currentPrompt: string;
  readonly sessionMode: 'design' | 'chat';
  readonly skillIds: readonly string[];
  readonly designSystemId: string | null;
  readonly attachmentIds: readonly string[];
  readonly commentAttachmentIds: readonly string[];
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly locale: string;
  readonly contextSelectionIds: readonly string[];
}

export type HostedRunStartOperation =
  | { readonly kind: 'run.create'; readonly intent: NormalizedHostedRunIntentV1 }
  | { readonly kind: 'chat.create'; readonly intent: NormalizedHostedRunIntentV1 };

export type HostedRunReadOperation =
  | {
      readonly kind: 'runs.list';
      readonly projectId?: string;
      readonly conversationId?: string;
      readonly status?: HostedRunStatus;
    }
  | { readonly kind: 'run.status'; readonly runId: string }
  | { readonly kind: 'run.agui'; readonly runId: string }
  | { readonly kind: 'run.genui.list'; readonly runId: string }
  | { readonly kind: 'project.genui.list'; readonly projectId: string }
  | { readonly kind: 'run.genui.surface'; readonly runId: string; readonly surfaceId: string };

export type HostedRunMutationOperation =
  | HostedRunStartOperation
  | { readonly kind: 'run.cancel'; readonly runId: string }
  | {
      readonly kind: 'run.feedback';
      readonly runId: string;
      readonly body: HostedRunFeedbackRequest;
    }
  | {
      readonly kind: 'run.genui.respond';
      readonly runId: string;
      readonly surfaceId: string;
      readonly body: { readonly value: JsonValue };
    }
  | {
      readonly kind: 'project.genui.revoke';
      readonly projectId: string;
      readonly surfaceId: string;
    };

export type HostedRunOperation = HostedRunReadOperation | HostedRunMutationOperation;

export interface HostedRunAgUiResponse {
  readonly events: readonly HostedAgUiEvent[];
}

export type HostedRunAdapterResponse =
  | HostedRunCreateResponse
  | HostedRunListResponse
  | HostedRunStatusResponse
  | HostedRunCancelResponse
  | HostedRunFeedbackResponse
  | HostedRunAgUiResponse
  | HostedRunGenUiResponse
  | HostedProjectGenUiResponse
  | HostedGenUiSurfaceResponse
  | HostedGenUiRespondResponse
  | HostedGenUiRevokeResponse;

/**
 * The semantic owner validates ownership/catalogue membership and performs the
 * actual operation. The adapter owns only the closed wire shape and response
 * projection. `mutateInLane` must await `execute`, when supplied, while the
 * caller's S+L lease is held; cancel resolves only after child reconciliation.
 */
export interface HostedRunSemanticDispatcher {
  read(authority: HostedRunAuthority, operation: HostedRunReadOperation): Promise<unknown>;
  mutateInLane(
    authority: HostedRunAuthority,
    operation: HostedRunMutationOperation,
    execute?: () => Promise<unknown>,
  ): Promise<unknown>;
  startChat(authority: HostedRunAuthority, operation: HostedRunStartOperation): Promise<unknown>;
}

export class HostedRunAdapterError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'HostedRunAdapterError';
  }
}

export function createHostedRunAdapter(dispatcher: HostedRunSemanticDispatcher): {
  dispatch(authority: HostedRunAuthority, request: unknown): Promise<HostedRunAdapterResponse>;
} {
  return {
    async dispatch(authority, request) {
      const scopedAuthority = validateAuthority(authority);
      const operation = validateRequest(request);
      let result: unknown;
      if (isStart(operation)) {
        result = await dispatcher.mutateInLane(
          scopedAuthority,
          operation,
          () => dispatcher.startChat(scopedAuthority, operation),
        );
      } else if (isMutation(operation)) {
        result = await dispatcher.mutateInLane(scopedAuthority, operation);
      } else {
        result = await dispatcher.read(scopedAuthority, operation);
      }
      return sanitizeResponse(operation, result);
    },
  };
}

function validateAuthority(authority: HostedRunAuthority): HostedRunAuthority {
  if (authority == null || typeof authority !== 'object') {
    throw badRequest('hosted run authority is invalid');
  }
  const userKey = authority.userKey;
  const generation = authority.generation;
  const bytes = typeof userKey === 'string'
    ? Buffer.from(userKey, 'utf8')
    : null;
  if (
    bytes == null
    || bytes.length < 1
    || bytes.length > 1_024
    || bytes.toString('utf8') !== userKey
    || !Number.isSafeInteger(generation)
    || generation < 1
  ) throw badRequest('hosted run authority is invalid');
  return Object.freeze({ userKey, generation });
}

function validateRequest(request: unknown): HostedRunOperation {
  const value = requestRecord(request, 'hosted run request');
  const kind = requiredString(value.kind, 'kind');
  switch (kind) {
    case 'run.create':
    case 'chat.create':
      exactKeys(value, ['kind', 'body']);
      return Object.freeze({ kind, intent: runIntent(value.body) });
    case 'runs.list': {
      optionalKeys(value, ['kind'], ['projectId', 'conversationId', 'status']);
      const projectId = optionalOpaqueId(value.projectId, 'projectId');
      const conversationId = optionalOpaqueId(value.conversationId, 'conversationId');
      const status = optionalRunStatus(value.status);
      return Object.freeze({
        kind,
        ...(projectId === undefined ? {} : { projectId }),
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(status === undefined ? {} : { status }),
      });
    }
    case 'run.status':
    case 'run.agui':
    case 'run.genui.list':
      exactKeys(value, ['kind', 'runId']);
      return Object.freeze({ kind, runId: opaqueId(value.runId, 'runId') });
    case 'project.genui.list':
      exactKeys(value, ['kind', 'projectId']);
      return Object.freeze({ kind, projectId: opaqueId(value.projectId, 'projectId') });
    case 'run.genui.surface':
      exactKeys(value, ['kind', 'runId', 'surfaceId']);
      return Object.freeze({
        kind,
        runId: opaqueId(value.runId, 'runId'),
        surfaceId: opaqueId(value.surfaceId, 'surfaceId'),
      });
    case 'run.cancel':
      exactKeys(value, ['kind', 'runId']);
      return Object.freeze({ kind, runId: opaqueId(value.runId, 'runId') });
    case 'run.feedback':
      exactKeys(value, ['kind', 'runId', 'body']);
      return Object.freeze({
        kind,
        runId: opaqueId(value.runId, 'runId'),
        body: feedbackRequest(value.body),
      });
    case 'run.genui.respond':
      exactKeys(value, ['kind', 'runId', 'surfaceId', 'body']);
      return Object.freeze({
        kind,
        runId: opaqueId(value.runId, 'runId'),
        surfaceId: opaqueId(value.surfaceId, 'surfaceId'),
        body: genUiRespondRequest(value.body),
      });
    case 'project.genui.revoke':
      exactKeys(value, ['kind', 'projectId', 'surfaceId']);
      return Object.freeze({
        kind,
        projectId: opaqueId(value.projectId, 'projectId'),
        surfaceId: opaqueId(value.surfaceId, 'surfaceId'),
      });
    default:
      throw badRequest('hosted run request kind is unsupported');
  }
}

function runIntent(input: unknown): NormalizedHostedRunIntentV1 {
  const value = requestRecord(input, 'hosted run intent');
  optionalKeys(value, [
    'projectId',
    'conversationId',
    'assistantMessageId',
    'agentId',
    'message',
    'clientRequestId',
  ], [
    'currentPrompt',
    'sessionMode',
    'skillIds',
    'designSystemId',
    'attachmentIds',
    'commentAttachmentIds',
    'model',
    'reasoning',
    'locale',
    'contextSelectionIds',
  ]);
  const message = boundedString(value.message, 'message', 0, MAX_MESSAGE_BYTES);
  const clientRequestId = requiredString(value.clientRequestId, 'clientRequestId');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(clientRequestId)) {
    throw badRequest('clientRequestId is invalid');
  }
  const sessionMode = value.sessionMode ?? 'design';
  if (sessionMode !== 'design' && sessionMode !== 'chat') {
    throw badRequest('sessionMode is invalid');
  }
  const skillIds = frozenIdArray(value.skillIds, 'skillIds', 32);
  const attachmentIds = frozenIdArray(value.attachmentIds, 'attachmentIds', 12);
  const commentAttachmentIds = frozenIdArray(
    value.commentAttachmentIds,
    'commentAttachmentIds',
    100,
  );
  const contextSelectionIds = frozenIdArray(
    value.contextSelectionIds,
    'contextSelectionIds',
    100,
  );
  return Object.freeze({
    projectId: opaqueId(value.projectId, 'projectId'),
    conversationId: opaqueId(value.conversationId, 'conversationId'),
    assistantMessageId: opaqueId(value.assistantMessageId, 'assistantMessageId'),
    agentId: opaqueId(value.agentId, 'agentId'),
    message,
    clientRequestId,
    currentPrompt: value.currentPrompt === undefined
      ? message
      : boundedString(value.currentPrompt, 'currentPrompt', 0, MAX_MESSAGE_BYTES),
    sessionMode,
    skillIds,
    designSystemId: nullableOpaqueId(value.designSystemId, 'designSystemId'),
    attachmentIds,
    commentAttachmentIds,
    model: nullableCatalogueValue(value.model, 'model', 512),
    reasoning: nullableCatalogueValue(value.reasoning, 'reasoning', 128),
    locale: value.locale === undefined ? 'en' : locale(value.locale),
    contextSelectionIds,
  });
}

function feedbackRequest(input: unknown): HostedRunFeedbackRequest {
  const value = requestRecord(input, 'hosted run feedback');
  exactKeys(value, [
    'projectId',
    'conversationId',
    'assistantMessageId',
    'rating',
    'reasonCodes',
    'hasCustomReason',
    'customReason',
  ]);
  if (value.rating !== 'positive' && value.rating !== 'negative') {
    throw badRequest('feedback rating is invalid');
  }
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length > 8) {
    throw badRequest('feedback reasonCodes are invalid');
  }
  const reasonCodes = value.reasonCodes.map((reason) => {
    if (typeof reason !== 'string' || !FEEDBACK_REASONS.has(reason)) {
      throw badRequest('feedback reasonCodes are invalid');
    }
    return reason as HostedRunFeedbackRequest['reasonCodes'][number];
  });
  if (typeof value.hasCustomReason !== 'boolean') {
    throw badRequest('feedback hasCustomReason is invalid');
  }
  return Object.freeze({
    projectId: opaqueId(value.projectId, 'projectId'),
    conversationId: opaqueId(value.conversationId, 'conversationId'),
    assistantMessageId: opaqueId(value.assistantMessageId, 'assistantMessageId'),
    rating: value.rating,
    // The legacy shared DTO spells this array mutable. The hosted boundary
    // freezes its accepted snapshot before it can wait in the mutation lane.
    reasonCodes: Object.freeze(reasonCodes) as unknown as HostedRunFeedbackRequest['reasonCodes'],
    hasCustomReason: value.hasCustomReason,
    customReason: boundedString(
      value.customReason,
      'customReason',
      0,
      MAX_FEEDBACK_REASON_BYTES,
    ),
  });
}

function genUiRespondRequest(input: unknown): { readonly value: JsonValue } {
  const body = requestRecord(input, 'hosted GenUI response');
  exactKeys(body, ['value']);
  return Object.freeze({ value: cloneJson(body.value, MAX_GEN_UI_VALUE_BYTES, 'request') });
}

function sanitizeResponse(
  operation: HostedRunOperation,
  input: unknown,
): HostedRunAdapterResponse {
  switch (operation.kind) {
    case 'run.create':
    case 'chat.create':
      return runCreateResponse(input);
    case 'runs.list':
      return runListResponse(input);
    case 'run.status':
      return runStatusResponse(input);
    case 'run.agui':
      return agUiResponse(input);
    case 'run.genui.list':
      return runGenUiResponse(input);
    case 'project.genui.list':
      return projectGenUiResponse(input);
    case 'run.genui.surface':
      return genUiSurfaceResponse(input);
    case 'run.cancel':
      return okResponse(input, 'cancel');
    case 'run.feedback':
      return feedbackResponse(input);
    case 'run.genui.respond':
      return genUiRespondResponse(input);
    case 'project.genui.revoke':
      return genUiRevokeResponse(input);
  }
}

function runCreateResponse(input: unknown): HostedRunCreateResponse {
  const value = responseRecord(input, 'run create');
  return {
    runId: responseId(value.runId, 'runId'),
    ...(value.conversationId === undefined
      ? {}
      : { conversationId: nullableResponseId(value.conversationId, 'conversationId') }),
    ...(value.assistantMessageId === undefined
      ? {}
      : { assistantMessageId: nullableResponseId(value.assistantMessageId, 'assistantMessageId') }),
  };
}

function runListResponse(input: unknown): HostedRunListResponse {
  const value = responseRecord(input, 'run list');
  const runs = responseArray(value.runs, 'runs', MAX_RUNS).map(runStatusResponse);
  return { runs };
}

function runStatusResponse(input: unknown): HostedRunStatusResponse {
  const value = responseRecord(input, 'run status');
  if (!HOSTED_RUN_STATUSES.includes(value.status as HostedRunStatus)) {
    throw internalError('hosted run status response is invalid');
  }
  const exitCode = value.exitCode === undefined
    ? undefined
    : value.exitCode === null
      ? null
      : responseInteger(value.exitCode, 'exitCode');
  const resumable = value.resumable === undefined
    ? undefined
    : responseBoolean(value.resumable, 'resumable');
  const errorCode = value.errorCode === undefined
    ? undefined
    : value.errorCode === null
      ? null
      : responseApiErrorCode(value.errorCode);
  return {
    id: responseId(value.id, 'runId'),
    projectId: nullableResponseId(value.projectId, 'projectId'),
    conversationId: nullableResponseId(value.conversationId, 'conversationId'),
    assistantMessageId: nullableResponseId(value.assistantMessageId, 'assistantMessageId'),
    agentId: nullableResponseId(value.agentId, 'agentId'),
    status: value.status as HostedRunStatus,
    createdAt: responseInteger(value.createdAt, 'createdAt'),
    updatedAt: responseInteger(value.updatedAt, 'updatedAt'),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(resumable === undefined ? {} : { resumable }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function agUiResponse(input: unknown): HostedRunAgUiResponse {
  const value = responseRecord(input, 'AGUI');
  const events = responseArray(value.events, 'AGUI events', MAX_AG_UI_EVENTS)
    .map(agUiEvent)
    .filter((event): event is HostedAgUiEvent => event != null);
  return { events };
}

function agUiEvent(input: unknown): HostedAgUiEvent | null {
  const value = responseRecord(input, 'AGUI event');
  if (!HOSTED_AG_UI_EVENT_KINDS.includes(value.kind as never)) return null;
  const base = {
    kind: value.kind,
    runId: responseId(value.runId, 'runId'),
    ...(value.seq === undefined ? {} : { seq: responseInteger(value.seq, 'seq') }),
    ts: responseInteger(value.ts, 'ts'),
  };
  switch (value.kind) {
    case 'agent.message':
      return {
        ...base,
        kind: 'agent.message',
        text: responseBoundedString(value.text, 'text', MAX_MESSAGE_BYTES),
        ...(value.done === undefined ? {} : { done: responseBoolean(value.done, 'done') }),
      };
    case 'tool_call': {
      if (!['started', 'completed', 'failed', undefined].includes(value.status as never)) {
        throw internalError('hosted AGUI tool status is invalid');
      }
      return {
        ...base,
        kind: 'tool_call',
        toolName: responseBoundedString(value.toolName, 'toolName', 256),
        args: cloneJson(value.args, MAX_GEN_UI_VALUE_BYTES, 'event'),
        ...(value.callId === undefined
          ? {}
          : { callId: responseBoundedString(value.callId, 'callId', 256) }),
        ...(value.status === undefined
          ? {}
          : { status: value.status as 'started' | 'completed' | 'failed' }),
        ...(value.result === undefined
          ? {}
          : { result: cloneJson(value.result, MAX_GEN_UI_VALUE_BYTES, 'event') }),
      };
    }
    case 'state_update':
      return {
        ...base,
        kind: 'state_update',
        path: responseBoundedString(value.path, 'state path', 4_096),
        value: cloneJson(value.value, MAX_GEN_UI_VALUE_BYTES, 'event'),
      };
    case 'ui.surface_requested':
      if (!HOSTED_GEN_UI_SURFACE_KINDS.includes(value.surfaceKind as never)) {
        throw internalError('hosted AGUI surface kind is invalid');
      }
      return {
        ...base,
        kind: 'ui.surface_requested',
        surfaceId: responseId(value.surfaceId, 'surfaceId'),
        surfaceKind: value.surfaceKind as HostedGenUiSurface['kind'],
        payload: cloneJson(value.payload, MAX_GEN_UI_VALUE_BYTES, 'event'),
      };
    case 'ui.surface_responded':
      if (!GEN_UI_RESPONDERS.has(String(value.respondedBy))) {
        throw internalError('hosted AGUI responder is invalid');
      }
      return {
        ...base,
        kind: 'ui.surface_responded',
        surfaceId: responseId(value.surfaceId, 'surfaceId'),
        value: cloneJson(value.value, MAX_GEN_UI_VALUE_BYTES, 'event'),
        respondedBy: value.respondedBy as HostedGenUiSurface['respondedBy'] & string,
      };
    case 'run.lifecycle':
      if (![
        'started', 'pipeline_stage_started', 'pipeline_stage_completed',
        'completed', 'cancelled', 'failed',
      ].includes(String(value.status))) throw internalError('hosted AGUI lifecycle status is invalid');
      return {
        ...base,
        kind: 'run.lifecycle',
        status: value.status as 'started' | 'pipeline_stage_started' | 'pipeline_stage_completed'
          | 'completed' | 'cancelled' | 'failed',
        ...(value.stageId === undefined
          ? {}
          : { stageId: responseBoundedString(value.stageId, 'stageId', 256) }),
        ...(value.iteration === undefined
          ? {}
          : { iteration: responseInteger(value.iteration, 'iteration') }),
        ...(value.message === undefined
          ? {}
          : { message: responseBoundedString(value.message, 'message', 64 * 1024) }),
      };
    default:
      return null;
  }
}

function runGenUiResponse(input: unknown): HostedRunGenUiResponse {
  const value = responseRecord(input, 'run GenUI');
  return {
    runId: responseId(value.runId, 'runId'),
    surfaces: responseArray(value.surfaces, 'surfaces', MAX_SURFACES).map((surface) => (
      genUiSurface(surface)
    )),
  };
}

function projectGenUiResponse(input: unknown): HostedProjectGenUiResponse {
  const value = responseRecord(input, 'project GenUI');
  return {
    projectId: responseId(value.projectId, 'projectId'),
    surfaces: responseArray(value.surfaces, 'surfaces', MAX_SURFACES).map((surface) => (
      genUiSurface(surface)
    )),
  };
}

function genUiSurfaceResponse(input: unknown): HostedGenUiSurfaceResponse {
  const value = responseRecord(input, 'GenUI surface response');
  return {
    ...genUiSurface(value),
    spec: value.spec === null ? null : genUiSpec(value.spec),
  };
}

function genUiSurface(input: unknown, forceUser = false): HostedGenUiSurface {
  const value = responseRecord(input, 'GenUI surface');
  if (!HOSTED_GEN_UI_SURFACE_KINDS.includes(value.kind as never)) {
    throw internalError('hosted GenUI kind is invalid');
  }
  if (!GEN_UI_PERSIST_TIERS.has(String(value.persist))) {
    throw internalError('hosted GenUI persistence is invalid');
  }
  if (!GEN_UI_STATUSES.has(String(value.status))) {
    throw internalError('hosted GenUI status is invalid');
  }
  if (!forceUser && value.respondedBy !== null && !GEN_UI_RESPONDERS.has(String(value.respondedBy))) {
    throw internalError('hosted GenUI responder is invalid');
  }
  return {
    id: responseId(value.id, 'surface row id'),
    projectId: responseId(value.projectId, 'projectId'),
    conversationId: nullableResponseId(value.conversationId, 'conversationId'),
    runId: nullableResponseId(value.runId, 'runId'),
    surfaceId: responseId(value.surfaceId, 'surfaceId'),
    kind: value.kind as HostedGenUiSurface['kind'],
    persist: value.persist as HostedGenUiSurface['persist'],
    value: cloneJson(value.value, MAX_GEN_UI_VALUE_BYTES, 'response'),
    status: value.status as HostedGenUiSurface['status'],
    respondedBy: forceUser ? 'user' : value.respondedBy as HostedGenUiSurface['respondedBy'],
    requestedAt: responseInteger(value.requestedAt, 'requestedAt'),
    respondedAt: nullableResponseInteger(value.respondedAt, 'respondedAt'),
    expiresAt: nullableResponseInteger(value.expiresAt, 'expiresAt'),
  };
}

function genUiSpec(input: unknown): NonNullable<HostedGenUiSurfaceResponse['spec']> {
  const value = responseRecord(input, 'GenUI spec');
  if (!HOSTED_GEN_UI_SURFACE_KINDS.includes(value.kind as never)) {
    throw internalError('hosted GenUI spec kind is invalid');
  }
  if (!GEN_UI_PERSIST_TIERS.has(String(value.persist))) {
    throw internalError('hosted GenUI spec persistence is invalid');
  }
  if (value.schema !== undefined && !isPlainRecord(value.schema)) {
    throw internalError('hosted GenUI schema is invalid');
  }
  if (value.onTimeout !== undefined && !['abort', 'default', 'skip'].includes(String(value.onTimeout))) {
    throw internalError('hosted GenUI timeout action is invalid');
  }
  return {
    id: responseId(value.id, 'surfaceId'),
    kind: value.kind as NonNullable<HostedGenUiSurfaceResponse['spec']>['kind'],
    persist: value.persist as NonNullable<HostedGenUiSurfaceResponse['spec']>['persist'],
    ...(value.schema === undefined
      ? {}
      : { schema: cloneJson(value.schema, MAX_GEN_UI_VALUE_BYTES, 'response') as Record<string, JsonValue> }),
    ...(value.prompt === undefined
      ? {}
      : { prompt: responseBoundedString(value.prompt, 'prompt', 64 * 1024) }),
    ...(value.timeout === undefined
      ? {}
      : { timeout: responsePositiveInteger(value.timeout, 'timeout') }),
    ...(value.onTimeout === undefined
      ? {}
      : { onTimeout: value.onTimeout as 'abort' | 'default' | 'skip' }),
    ...(value.default === undefined
      ? {}
      : { default: cloneJson(value.default, MAX_GEN_UI_VALUE_BYTES, 'response') }),
  };
}

function genUiRespondResponse(input: unknown): HostedGenUiRespondResponse {
  const value = responseRecord(input, 'GenUI respond');
  if (value.ok !== true) throw internalError('hosted GenUI respond response is invalid');
  return { ok: true, surface: genUiSurface(value.surface, true) };
}

function genUiRevokeResponse(input: unknown): HostedGenUiRevokeResponse {
  const value = responseRecord(input, 'GenUI revoke');
  if (value.ok !== true) throw internalError('hosted GenUI revoke response is invalid');
  return { ok: true, invalidated: responseInteger(value.invalidated, 'invalidated') };
}

function feedbackResponse(input: unknown): HostedRunFeedbackResponse {
  const value = responseRecord(input, 'feedback');
  if (!FEEDBACK_RESULTS.has(String(value.status))) {
    throw internalError('hosted feedback response is invalid');
  }
  return { status: value.status as HostedRunFeedbackResponse['status'] };
}

function okResponse(input: unknown, name: string): { ok: true } {
  const value = responseRecord(input, name);
  if (value.ok !== true) throw internalError(`hosted ${name} response is invalid`);
  return { ok: true };
}

function cloneJson(
  input: unknown,
  maxBytes: number,
  mode: 'request' | 'response' | 'event',
): JsonValue {
  const seen = new Set<object>();
  const budget = { nodes: 0 };
  let clone: JsonValue;
  try {
    clone = cloneJsonValue(input, mode, seen, budget, 0);
  } catch {
    if (mode === 'request') throw badRequest('GenUI value must be bounded JSON');
    throw internalError('hosted JSON response is invalid');
  }
  if (Buffer.byteLength(JSON.stringify(clone), 'utf8') > maxBytes) {
    if (mode === 'request') throw badRequest('GenUI value exceeds its hosted bound');
    throw internalError('hosted JSON response exceeds its bound');
  }
  return clone;
}

function cloneJsonValue(
  input: unknown,
  mode: 'request' | 'response' | 'event',
  seen: Set<object>,
  budget: { nodes: number },
  depth: number,
): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('JSON bound');
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    return mode === 'event' && looksLikeAbsolutePath(input) ? '[redacted]' : input;
  }
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (input == null || typeof input !== 'object') throw new Error('not JSON');
  if (seen.has(input)) throw new Error('cyclic JSON');
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      return input.map((item) => cloneJsonValue(item, mode, seen, budget, depth + 1));
    }
    if (!isPlainRecord(input)) throw new Error('not a JSON object');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const output: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error('JSON symbol key');
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('JSON accessor');
      if (mode === 'event' && forbiddenEventKey(key)) continue;
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(descriptor.value, mode, seen, budget, depth + 1),
        writable: true,
      });
    }
    return output;
  } finally {
    seen.delete(input);
  }
}

function forbiddenEventKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return normalized === 'raw'
    || normalized === 'rawevent'
    || normalized === 'events'
    || normalized === 'owner'
    || normalized === 'userid'
    || normalized === 'userkey'
    || normalized === 'storagekey'
    || normalized === 'tenant'
    || normalized === 'namespace'
    || normalized === 'grant'
    || normalized === 'grants'
    || normalized === 'token'
    || normalized === 'secret'
    || normalized === 'secrets'
    || normalized === 'credential'
    || normalized === 'credentials'
    || normalized === 'authorization'
    || normalized === 'apikey'
    || normalized === 'providerkey'
    || normalized === 'providerendpoint'
    || normalized === 'baseurl'
    || normalized === 'headers'
    || normalized === 'environment'
    || normalized === 'env'
    || normalized === 'executable'
    || normalized === 'command'
    || normalized === 'cwd'
    || normalized === 'socket'
    || normalized.endsWith('path')
    || normalized.endsWith('root')
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('apikey')
    || normalized.endsWith('credential');
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('/')
    || /^file:/iu.test(value);
}

function isStart(operation: HostedRunOperation): operation is HostedRunStartOperation {
  return operation.kind === 'run.create' || operation.kind === 'chat.create';
}

function isMutation(operation: HostedRunOperation): operation is HostedRunMutationOperation {
  return isStart(operation) || [
    'run.cancel',
    'run.feedback',
    'run.genui.respond',
    'project.genui.revoke',
  ].includes(operation.kind);
}

function requestRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isPlainRecord(input)) throw badRequest(`${name} must be an object`);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') throw badRequest(`${name} contains unsupported fields`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw badRequest(`${name} contains unsupported fields`);
    }
  }
  return input;
}

function responseRecord(input: unknown, name: string): Record<string, unknown> {
  if (!isPlainRecord(input)) throw internalError(`hosted ${name} response is invalid`);
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  optionalKeys(value, required, []);
}

function optionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw badRequest('hosted run request contains unsupported fields');
}

function opaqueId(input: unknown, name: string): string {
  if (!isSafeId(input)) throw badRequest(`${name} is invalid`);
  return input as string;
}

function optionalOpaqueId(input: unknown, name: string): string | undefined {
  return input === undefined ? undefined : opaqueId(input, name);
}

function nullableOpaqueId(input: unknown, name: string): string | null {
  return input == null ? null : opaqueId(input, name);
}

function requiredString(input: unknown, name: string): string {
  if (typeof input !== 'string') throw badRequest(`${name} must be a string`);
  return input;
}

function boundedString(
  input: unknown,
  name: string,
  minBytes: number,
  maxBytes: number,
): string {
  const value = requiredString(input, name);
  const bytes = Buffer.from(value, 'utf8');
  if (
    bytes.length < minBytes
    || bytes.length > maxBytes
    || bytes.toString('utf8') !== value
    || value.includes('\0')
  ) throw badRequest(`${name} is outside its hosted bound`);
  return value;
}

function nullableCatalogueValue(input: unknown, name: string, maxBytes: number): string | null {
  return input == null ? null : boundedString(input, name, 1, maxBytes);
}

function frozenIdArray(input: unknown, name: string, max: number): readonly string[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > max) throw badRequest(`${name} is invalid`);
  return Object.freeze(input.map((id) => opaqueId(id, name)));
}

function locale(input: unknown): string {
  const value = boundedString(input, 'locale', 1, 64);
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(value)) throw badRequest('locale is invalid');
  return value;
}

function optionalRunStatus(input: unknown): HostedRunStatus | undefined {
  if (input === undefined) return undefined;
  if (!HOSTED_RUN_STATUSES.includes(input as HostedRunStatus)) {
    throw badRequest('run status is invalid');
  }
  return input as HostedRunStatus;
}

function responseArray(input: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) {
    throw internalError(`hosted ${name} response is invalid`);
  }
  return input;
}

function responseId(input: unknown, name: string): string {
  try {
    return opaqueId(input, name);
  } catch {
    throw internalError(`hosted ${name} response is invalid`);
  }
}

function nullableResponseId(input: unknown, name: string): string | null {
  return input === null ? null : responseId(input, name);
}

function responseInteger(input: unknown, name: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw internalError(`hosted ${name} response is invalid`);
  }
  return input as number;
}

function responsePositiveInteger(input: unknown, name: string): number {
  const value = responseInteger(input, name);
  if (value < 1) throw internalError(`hosted ${name} response is invalid`);
  return value;
}

function nullableResponseInteger(input: unknown, name: string): number | null {
  return input === null ? null : responseInteger(input, name);
}

function responseBoolean(input: unknown, name: string): boolean {
  if (typeof input !== 'boolean') throw internalError(`hosted ${name} response is invalid`);
  return input;
}

function responseBoundedString(input: unknown, name: string, maxBytes: number): string {
  if (typeof input !== 'string') throw internalError(`hosted ${name} response is invalid`);
  const bytes = Buffer.from(input, 'utf8');
  if (bytes.length > maxBytes || bytes.toString('utf8') !== input || input.includes('\0')) {
    throw internalError(`hosted ${name} response is invalid`);
  }
  return input;
}

function responseApiErrorCode(input: unknown): HostedRunStatusResponse['errorCode'] {
  if (!API_ERROR_CODES.includes(input as never)) {
    throw internalError('hosted errorCode response is invalid');
  }
  return input as HostedRunStatusResponse['errorCode'];
}

function badRequest(message: string): HostedRunAdapterError {
  return new HostedRunAdapterError('BAD_REQUEST', message);
}

function internalError(message: string): HostedRunAdapterError {
  return new HostedRunAdapterError('INTERNAL_ERROR', message);
}
