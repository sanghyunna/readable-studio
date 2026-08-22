import {
  API_ERROR_CODES,
  createApiError,
  HOSTED_RUN_STATUSES,
  type ApiErrorCode,
  type HostedGenUiSurface,
  type HostedRunFeedbackRequest,
} from '@readable-studio/contracts';
import type { Express, RequestHandler, Response } from 'express';

import {
  dispatchHostedRuntimeInternalOperation,
  HostedRuntimeError,
  type HostedRuntimeRegistry,
} from '../hosted-runtime-registry.js';
import type {
  HostedDurableEventMilestone,
  HostedEventChannel,
} from '../hosted-event-journal.js';
import {
  HOSTED_LAST_EVENT_ID_MAX_BYTES,
  type HostedSseOpenResult,
} from '../hosted-sse-adapter.js';
import {
  createHostedRunAdapter,
  type HostedRunMutationOperation,
  type HostedRunReadOperation,
  type HostedRunStartOperation,
} from '../hosted-run-adapter.js';
import {
  hostedApiFailure,
  hostedRequestState,
  hostedRouteParam,
  type HostedRequestState,
} from './hosted-http.js';
import type { HostedMetadataDispatch } from './hosted-metadata.js';
import { hostedProviderModel } from './hosted-provider.js';

const HOSTED_THINKING_CATALOGUE = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export interface HostedRunRouteDependencies {
  readonly authenticate: RequestHandler;
  readonly createRunId: (userKey: string) => string;
  readonly dispatchMetadata: HostedMetadataDispatch;
  readonly exactQuery: (allowed: readonly string[]) => RequestHandler;
  readonly hostedJson: RequestHandler;
  readonly noInput: RequestHandler;
  readonly registry: HostedRuntimeRegistry;
  readonly rejectAuthorityBody: RequestHandler;
  readonly rejectAuthorityMetadata: RequestHandler;
  readonly requireMutationAuthority: RequestHandler;
}

export function registerHostedRunRoutes(
  app: Express,
  dependencies: HostedRunRouteDependencies,
): void {
  const {
    authenticate,
    createRunId,
    dispatchMetadata,
    exactQuery,
    hostedJson,
    noInput,
    registry,
    rejectAuthorityBody,
    rejectAuthorityMetadata,
    requireMutationAuthority,
  } = dependencies;

  const requireRun = async (
    state: HostedRequestState,
    runId: string,
  ): Promise<Record<string, unknown>> => {
    const result = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
      kind: 'run:get',
      runId,
    });
    if (result == null || typeof result !== 'object' || Array.isArray(result)) {
      throw new HostedRuntimeError('NOT_FOUND', 'hosted run was not found');
    }
    return result as Record<string, unknown>;
  };
  const runEvents = async (state: HostedRequestState, runId: string): Promise<unknown[]> => {
    const replay = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
      kind: 'journal:replay',
      channel: { kind: 'run-ui', runId },
    });
    return isEventReplay(replay) ? replay.events.map(({ data }) => data) : [];
  };
  const openEventStream = async (
    state: HostedRequestState,
    channel: HostedEventChannel,
    lastEventId: string | string[] | undefined,
    response: Response,
  ): Promise<HostedSseOpenResult> => {
    const after = parseLastEventId(lastEventId);
    if (after.kind === 'bad-request') return after.result;
    const lease = registry.acquire({ userKey: state.identity.userKey }, 'weak');
    if (
      lease.storageKey !== state.lease.storageKey
      || lease.generation !== state.lease.generation
    ) {
      lease.release();
      return { code: 'HOSTED_RUNTIME_UNAVAILABLE', kind: 'unavailable' };
    }
    setSseHeaders(response);
    let attached: Awaited<ReturnType<typeof dispatchHostedRuntimeInternalOperation>>;
    try {
      attached = await dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'journal:attach',
        after: after.value,
        channel,
        response,
      });
    } catch (error) {
      clearSseHeaders(response);
      lease.release();
      throw error;
    }
    const result = attached as HostedSseOpenResult;
    if (result.kind !== 'attached') {
      lease.release();
      if (result.kind !== 'resync') clearSseHeaders(response);
      return result;
    }
    if (response.destroyed || response.writableEnded) {
      result.close();
      lease.release();
      return result;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      response.off('close', release);
      response.off('finish', release);
      lease.release();
    };
    response.on('close', release);
    response.on('finish', release);
    try {
      response.flushHeaders();
    } catch (error) {
      result.close();
      release();
      throw error;
    }
    return result;
  };
  const dispatchRun = (
    state: HostedRequestState,
    request: unknown,
  ) => createHostedRunAdapter({
    async read(_authority, operation: HostedRunReadOperation) {
      switch (operation.kind) {
        case 'runs.list':
          return dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'runs:list',
            ...(operation.projectId === undefined ? {} : { projectId: operation.projectId }),
            ...(operation.conversationId === undefined
              ? {}
              : { conversationId: operation.conversationId }),
            ...(operation.status === undefined ? {} : { status: operation.status }),
          });
        case 'run.status':
          return requireRun(state, operation.runId);
        case 'run.agui':
          await requireRun(state, operation.runId);
          return { events: await runEvents(state, operation.runId) };
        case 'run.genui.list': {
          const run = await requireRun(state, operation.runId);
          return {
            runId: operation.runId,
            surfaces: hostedGenUiSurfaces(run, await runEvents(state, operation.runId)),
          };
        }
        case 'project.genui.list': {
          await dispatchMetadata(state, {
            kind: 'project.get',
            projectId: operation.projectId,
          });
          const listed = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'runs:list',
            projectId: operation.projectId,
          }) as { runs?: unknown };
          const runs = Array.isArray(listed.runs) ? listed.runs : [];
          const surfaces = await Promise.all(runs.map(async (run) => {
            if (run == null || typeof run !== 'object' || Array.isArray(run)) return [];
            const record = run as Record<string, unknown>;
            return typeof record.id === 'string'
              ? hostedGenUiSurfaces(record, await runEvents(state, record.id))
              : [];
          }));
          return {
            projectId: operation.projectId,
            surfaces: surfaces.flat(),
          };
        }
        case 'run.genui.surface': {
          const run = await requireRun(state, operation.runId);
          const surface = hostedGenUiSurfaces(run, await runEvents(state, operation.runId))
            .find(({ surfaceId }) => surfaceId === operation.surfaceId);
          if (surface == null) {
            throw new HostedRuntimeError('NOT_FOUND', 'hosted GenUI surface was not found');
          }
          return surface;
        }
      }
    },
    async mutateInLane(
      _authority,
      operation: HostedRunMutationOperation,
      execute?: () => Promise<unknown>,
    ) {
      if (execute != null) return execute();
      switch (operation.kind) {
        case 'run.cancel': {
          const status = await requireRun(state, operation.runId);
          if (!HOSTED_RUN_STATUSES.slice(2).includes(status.status as never)) {
            registry.cancel({
              userKey: state.identity.userKey,
              generation: state.lease.generation,
              runId: operation.runId,
            }, 'client request');
            await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
              kind: 'run:wait',
              runId: operation.runId,
            });
          }
          return { ok: true };
        }
        case 'run.feedback': {
          const status = await requireRun(state, operation.runId);
          assertRunReferences(status, operation.body);
          return dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'run:mutate',
            scope: { kind: 'run', runId: operation.runId },
            execute: () => ({ status: 'skipped_no_sink' }),
          });
        }
        case 'run.genui.respond': {
          const mutation = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'journal:mutate',
            scope: { kind: 'run', runId: operation.runId },
            execute: async () => {
              const run = await requireRun(state, operation.runId);
              const surfaces = hostedGenUiSurfaces(
                run,
                await runEvents(state, operation.runId),
              );
              const current = surfaces.find(({ surfaceId, status }) => (
                surfaceId === operation.surfaceId && status === 'pending'
              ));
              if (current == null) {
                throw new HostedRuntimeError('NOT_FOUND', 'hosted GenUI surface was not found');
              }
              const at = Date.now();
              const next = {
                ...current,
                value: operation.body.value,
                status: 'resolved',
                respondedBy: 'user',
                respondedAt: at,
              } as const;
              return {
                events: [{
                  channel: { kind: 'run-ui' as const, runId: operation.runId },
                  event: 'genui-responded',
                  data: { kind: 'ui.surface_responded', runId: operation.runId, ts: at,
                    surfaceId: operation.surfaceId, value: operation.body.value,
                    respondedBy: 'user' },
                  milestone: 'status-transition' as const,
                }],
                value: { surface: next },
              };
            },
          }) as { surface: HostedGenUiSurface };
          return { ok: true, surface: mutation.surface };
        }
        case 'project.genui.revoke': {
          const mutation = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'journal:mutate',
            scope: { kind: 'project', projectId: operation.projectId },
            execute: async () => {
              const listed = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
                kind: 'runs:list',
                projectId: operation.projectId,
              }) as { runs?: unknown };
              const runs = Array.isArray(listed.runs) ? listed.runs : [];
              const candidates = await Promise.all(runs.map(async (run) => {
                if (run == null || typeof run !== 'object' || Array.isArray(run)) return [];
                const record = run as Record<string, unknown>;
                if (typeof record.id !== 'string') return [];
                return hostedGenUiSurfaces(record, await runEvents(state, record.id))
                  .filter(({ surfaceId, status }) => (
                    surfaceId === operation.surfaceId && status === 'pending'
                  ))
                  .map(() => record.id as string);
              }));
              const matches = candidates.flat();
              if (matches.length === 0) {
                throw new HostedRuntimeError('NOT_FOUND', 'hosted GenUI surface was not found');
              }
              const at = Date.now();
              return {
                events: matches.map((runId) => ({
                  channel: { kind: 'run-ui' as const, runId },
                  event: 'genui-invalidated',
                  data: { kind: 'ui.surface_invalidated', runId, ts: at,
                    surfaceId: operation.surfaceId },
                  milestone: 'status-transition' as const,
                })),
                value: { invalidated: matches.length },
              };
            },
          }) as { invalidated: number };
          return { ok: true, invalidated: mutation.invalidated };
        }
        case 'run.create':
        case 'chat.create':
          throw new HostedRuntimeError('INTERNAL_ERROR', 'hosted run dispatch is invalid');
      }
    },
    async startChat(_authority, operation: HostedRunStartOperation) {
      await dispatchMetadata(state, {
        kind: 'project.get',
        projectId: operation.intent.projectId,
      });
      const messages = await dispatchMetadata(state, {
        kind: 'messages.list',
        projectId: operation.intent.projectId,
        conversationId: operation.intent.conversationId,
      });
      if (
        !('messages' in messages)
        || !messages.messages.some((message) => (
          message.id === operation.intent.assistantMessageId
          && message.role === 'assistant'
        ))
      ) {
        throw new HostedRuntimeError('MESSAGE_NOT_FOUND', 'hosted message was not found');
      }
      const credential = registry.credentialStatus(state.lease);
      const fixedModel = credential.provider == null ? '' : hostedProviderModel(credential.provider);
      const runId = createRunId(state.identity.userKey);
      return dispatchHostedRuntimeInternalOperation(registry, state.lease, {
        kind: 'run:start',
        runId,
        routeKind: operation.kind === 'chat.create' ? 'chat' : 'runs',
        intent: operation.intent,
        model: fixedModel,
        modelCatalogue: fixedModel === '' ? [] : [fixedModel],
        thinkingCatalogue: HOSTED_THINKING_CATALOGUE,
        mapEvent(channel, payload) {
          const events = hostedRunEvents(channel, payload, {
            agentId: operation.intent.agentId,
            model: fixedModel,
            projectId: operation.intent.projectId,
            reasoning: operation.intent.reasoning,
            runId,
          });
          return [
            ...events.publicEvents.map((event) => ({
              channel: { kind: 'run' as const, runId },
              ...event,
            })),
            ...(events.internalEvent == null
              ? []
              : [{
                  channel: { kind: 'run-ui' as const, runId },
                  ...events.internalEvent,
                }]),
          ];
        },
      });
    },
  }).dispatch({
    userKey: state.identity.userKey,
    generation: state.lease.generation,
  }, request);

  app.get(
    '/api/projects/:id/events',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      const state = hostedRequestState(response);
      const projectId = hostedRouteParam(request, 'id');
      await dispatchMetadata(state, { kind: 'project.get', projectId });
      const result = await openEventStream(
        state,
        { kind: 'project', projectId },
        request.headers['last-event-id'],
        response,
      );
      state.lease.release();
      handleSseOpenResult(response, result);
    },
  );
  app.get(
    '/api/runs',
    authenticate,
    rejectAuthorityMetadata,
    exactQuery(['projectId', 'conversationId', 'status']),
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'runs.list',
        ...(Object.hasOwn(request.query, 'projectId')
          ? { projectId: request.query.projectId }
          : {}),
        ...(Object.hasOwn(request.query, 'conversationId')
          ? { conversationId: request.query.conversationId }
          : {}),
        ...(Object.hasOwn(request.query, 'status')
          ? { status: request.query.status }
          : {}),
      }));
    },
  );
  app.post(
    '/api/runs',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      const result = await dispatchRun(hostedRequestState(response), {
        kind: 'run.create',
        body: request.body,
      });
      response.status(202).json(result);
    },
  );
  app.post(
    '/api/chat',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      const state = hostedRequestState(response);
      const result = await dispatchRun(state, { kind: 'chat.create', body: request.body });
      if (
        result == null
        || typeof result !== 'object'
        || Array.isArray(result)
        || typeof (result as { runId?: unknown }).runId !== 'string'
      ) throw new HostedRuntimeError('INTERNAL_ERROR', 'hosted chat admission failed');
      const runId = (result as { runId: string }).runId;
      const opened = await openEventStream(
        state,
        { kind: 'run', runId },
        undefined,
        response,
      );
      state.lease.release();
      handleSseOpenResult(response, opened);
    },
  );
  app.get(
    '/api/runs/:id',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.status',
        runId: hostedRouteParam(request, 'id'),
      }));
    },
  );
  app.get(
    '/api/runs/:id/events',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      const state = hostedRequestState(response);
      const runId = hostedRouteParam(request, 'id');
      await requireRun(state, runId);
      const result = await openEventStream(
        state,
        { kind: 'run', runId },
        request.headers['last-event-id'],
        response,
      );
      state.lease.release();
      handleSseOpenResult(response, result);
    },
  );
  app.post(
    '/api/runs/:id/cancel',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.cancel',
        runId: hostedRouteParam(request, 'id'),
      }));
    },
  );
  app.post(
    '/api/runs/:id/feedback',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.feedback',
        runId: hostedRouteParam(request, 'id'),
        body: request.body,
      }));
    },
  );
  app.get(
    '/api/runs/:id/agui',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.agui', runId: hostedRouteParam(request, 'id'),
      }));
    },
  );
  app.get(
    '/api/runs/:id/genui',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.genui.list', runId: hostedRouteParam(request, 'id'),
      }));
    },
  );
  app.get(
    '/api/projects/:projectId/genui',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'project.genui.list', projectId: hostedRouteParam(request, 'projectId'),
      }));
    },
  );
  app.get(
    '/api/runs/:runId/genui/:surfaceId',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.genui.surface',
        runId: hostedRouteParam(request, 'runId'),
        surfaceId: hostedRouteParam(request, 'surfaceId'),
      }));
    },
  );
  app.post(
    '/api/runs/:runId/genui/:surfaceId/respond',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'run.genui.respond',
        runId: hostedRouteParam(request, 'runId'),
        surfaceId: hostedRouteParam(request, 'surfaceId'),
        body: request.body,
      }));
    },
  );
  app.post(
    '/api/projects/:projectId/genui/:surfaceId/revoke',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    noInput,
    async (request, response) => {
      response.json(await dispatchRun(hostedRequestState(response), {
        kind: 'project.genui.revoke',
        projectId: hostedRouteParam(request, 'projectId'),
        surfaceId: hostedRouteParam(request, 'surfaceId'),
      }));
    },
  );
}

function parseLastEventId(value: string | string[] | undefined):
  | { readonly kind: 'ok'; readonly value: string | null }
  | { readonly kind: 'bad-request'; readonly result: HostedSseOpenResult } {
  if (value === undefined) return { kind: 'ok', value: null };
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > HOSTED_LAST_EVENT_ID_MAX_BYTES
    || !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    return {
      kind: 'bad-request',
      result: { code: 'BAD_REQUEST', kind: 'bad-request', message: 'Last-Event-ID is invalid' },
    };
  }
  return { kind: 'ok', value };
}

function setSseHeaders(response: Response): void {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
}

function clearSseHeaders(response: Response): void {
  for (const name of ['Content-Type', 'Cache-Control', 'Connection', 'X-Accel-Buffering']) {
    response.removeHeader(name);
  }
}

function isEventReplay(input: unknown): input is {
  readonly kind: 'events';
  readonly events: ReadonlyArray<{ readonly data: unknown }>;
} {
  return input != null
    && typeof input === 'object'
    && (input as { kind?: unknown }).kind === 'events'
    && Array.isArray((input as { events?: unknown }).events);
}

function handleSseOpenResult(response: Response, result: HostedSseOpenResult): void {
  if (result.kind === 'attached' || result.kind === 'resync') return;
  if (result.kind === 'bad-request') {
    hostedApiFailure(response, 400, result.code, result.message);
    return;
  }
  if (result.kind === 'not-owned') {
    hostedApiFailure(response, 404, 'NOT_FOUND', 'hosted stream was not found');
    return;
  }
  if (result.kind === 'unavailable') {
    hostedApiFailure(response, 503, result.code, 'hosted stream is unavailable');
    return;
  }
  hostedApiFailure(
    response,
    result.code === 'HOSTED_OVERLOADED' ? 429 : 503,
    result.code,
    'hosted stream capacity is exhausted',
  );
}

function assertRunReferences(
  run: Record<string, unknown>,
  feedback: HostedRunFeedbackRequest,
): void {
  if (
    run.projectId !== feedback.projectId
    || run.conversationId !== feedback.conversationId
    || run.assistantMessageId !== feedback.assistantMessageId
  ) {
    throw new HostedRuntimeError('NOT_FOUND', 'hosted run was not found');
  }
}

function hostedRunEvents(
  channel: string,
  payload: Record<string, unknown>,
  context: {
    readonly agentId: string;
    readonly model: string;
    readonly projectId: string;
    readonly reasoning: string | null;
    readonly runId: string;
  },
): {
  internalEvent: {
    event: string;
    data: Record<string, unknown>;
    milestone: HostedDurableEventMilestone | null;
  } | null;
  publicEvents: Array<{
    event: string;
    data: Record<string, unknown>;
    milestone: HostedDurableEventMilestone | null;
  }>;
} {
  const ts = Number.isSafeInteger(payload.ts) ? payload.ts : Date.now();
  const runId = context.runId;
  if (payload.kind === 'run.lifecycle') {
    const status = String(payload.status);
    const internalEvent = {
      event: 'run.lifecycle',
      data: { ...payload, runId, status, ts },
      milestone: (status === 'created'
        ? 'run-created'
        : status === 'completed' || status === 'failed' || status === 'cancelled'
          ? 'terminal'
          : 'status-transition') as HostedDurableEventMilestone,
    };
    if (status === 'created') {
      return {
        internalEvent: null,
        publicEvents: [{
          event: 'start',
          data: {
            agentId: context.agentId,
            model: context.model,
            projectId: context.projectId,
            reasoning: context.reasoning,
            runId,
          },
          milestone: 'run-created',
        }],
      };
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const endStatus = status === 'completed'
        ? 'succeeded'
        : status === 'cancelled'
          ? 'canceled'
          : 'failed';
      const errorCode = API_ERROR_CODES.includes(payload.errorCode as ApiErrorCode)
        ? payload.errorCode as ApiErrorCode
        : 'INTERNAL_ERROR';
      return {
        internalEvent,
        publicEvents: [
          ...(status === 'failed'
            ? [{
                event: 'error',
                data: {
                  message: 'hosted run failed',
                  error: createApiError(errorCode, 'hosted run failed'),
                },
                milestone: 'terminal' as const,
              }]
            : []),
          {
            event: 'end',
            data: {
              code: Number.isInteger(payload.exitCode) ? payload.exitCode : null,
              signal: typeof payload.signal === 'string' ? payload.signal : null,
              status: endStatus,
            },
            milestone: 'terminal' as const,
          },
        ],
      };
    }
    return { internalEvent, publicEvents: [] };
  }
  if (typeof payload.kind === 'string') {
    return {
      internalEvent: {
        event: /^[A-Za-z0-9_.-]{1,64}$/u.test(channel) ? channel : 'agent',
        data: { ...payload, runId, ts },
        milestone: payload.kind.startsWith('ui.') ? 'status-transition' : null,
      },
      publicEvents: [],
    };
  }
  const text = typeof payload.delta === 'string'
    ? payload.delta
    : typeof payload.text === 'string'
      ? payload.text
      : typeof payload.content === 'string'
        ? payload.content
        : null;
  if (text != null) {
    return {
      internalEvent: {
        event: 'agent.message',
        data: { kind: 'agent.message', runId, text, ts },
        milestone: null,
      },
      publicEvents: [{
        event: 'agent',
        data: { type: 'text_delta', delta: text },
        milestone: null,
      }],
    };
  }
  return { internalEvent: null, publicEvents: [] };
}

function hostedGenUiSurfaces(
  run: Record<string, unknown>,
  events: readonly unknown[],
): Array<HostedGenUiSurface & { spec: Record<string, unknown> | null }> {
  if (typeof run.id !== 'string' || typeof run.projectId !== 'string') return [];
  const surfaces = new Map<
    string,
    HostedGenUiSurface & { spec: Record<string, unknown> | null }
  >();
  for (const raw of events) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (
      event.kind === 'ui.surface_requested'
      && typeof event.surfaceId === 'string'
      && ['form', 'choice', 'confirmation', 'oauth-prompt'].includes(String(event.surfaceKind))
    ) {
      const payload = event.payload != null
        && typeof event.payload === 'object'
        && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      const requestedAt = Number.isSafeInteger(event.ts) ? event.ts as number : Date.now();
      const persist = ['run', 'conversation', 'project'].includes(String(payload.persist))
        ? payload.persist as HostedGenUiSurface['persist']
        : 'run';
      const surfaceId = event.surfaceId;
      surfaces.set(surfaceId, {
        id: `${run.id}-${surfaceId}`,
        projectId: run.projectId,
        conversationId: typeof run.conversationId === 'string' ? run.conversationId : null,
        runId: run.id,
        surfaceId,
        kind: event.surfaceKind as HostedGenUiSurface['kind'],
        persist,
        value: null,
        status: 'pending',
        respondedBy: null,
        requestedAt,
        respondedAt: null,
        expiresAt: Number.isSafeInteger(payload.expiresAt) ? payload.expiresAt as number : null,
        spec: {
          id: surfaceId,
          kind: event.surfaceKind,
          persist,
          ...(payload.schema === undefined ? {} : { schema: payload.schema }),
          ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
          ...(payload.timeout === undefined ? {} : { timeout: payload.timeout }),
          ...(payload.onTimeout === undefined ? {} : { onTimeout: payload.onTimeout }),
          ...(payload.default === undefined ? {} : { default: payload.default }),
        },
      });
      continue;
    }
    if (event.kind === 'ui.surface_responded' && typeof event.surfaceId === 'string') {
      const current = surfaces.get(event.surfaceId);
      if (current == null) continue;
      surfaces.set(event.surfaceId, {
        ...current,
        value: event.value as HostedGenUiSurface['value'],
        status: 'resolved',
        respondedBy: 'user',
        respondedAt: Number.isSafeInteger(event.ts) ? event.ts as number : Date.now(),
      });
    } else if (event.kind === 'ui.surface_invalidated' && typeof event.surfaceId === 'string') {
      const existing = surfaces.get(event.surfaceId);
      if (existing == null) continue;
      surfaces.set(event.surfaceId, {
        ...existing,
        status: 'invalidated',
        respondedAt: Number.isSafeInteger(event.ts) ? event.ts as number : Date.now(),
      });
    }
  }
  return [...surfaces.values()];
}
