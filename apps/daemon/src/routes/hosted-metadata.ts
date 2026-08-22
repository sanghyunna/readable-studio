import type { Express, RequestHandler } from 'express';

import {
  dispatchHostedRuntimeInternalOperation,
  type HostedRuntimeRegistry,
} from '../hosted-runtime-registry.js';
import {
  createHostedMetadataAdapter,
  type HostedMetadataMutationOperation,
  type HostedMetadataReadOperation,
} from '../hosted-metadata-adapter.js';
import {
  hostedRequestState,
  hostedRouteParam,
  type HostedRequestState,
} from './hosted-http.js';

type HostedMetadataDispatchResult = Awaited<
  ReturnType<ReturnType<typeof createHostedMetadataAdapter>['dispatch']>
>;

export type HostedMetadataDispatch = (
  state: HostedRequestState,
  request: unknown,
) => Promise<HostedMetadataDispatchResult>;

export interface HostedMetadataRouteDependencies {
  readonly authenticate: RequestHandler;
  readonly exactQuery: (allowed: readonly string[]) => RequestHandler;
  readonly hostedJson: RequestHandler;
  readonly noInput: RequestHandler;
  readonly registry: HostedRuntimeRegistry;
  readonly rejectAuthorityBody: RequestHandler;
  readonly rejectAuthorityMetadata: RequestHandler;
  readonly requireMutationAuthority: RequestHandler;
}

export function registerHostedMetadataRoutes(
  app: Express,
  dependencies: HostedMetadataRouteDependencies,
): HostedMetadataDispatch {
  const {
    authenticate,
    exactQuery,
    hostedJson,
    noInput,
    registry,
    rejectAuthorityBody,
    rejectAuthorityMetadata,
    requireMutationAuthority,
  } = dependencies;
  const dispatchMetadata: HostedMetadataDispatch = (state, request) => (
    createHostedMetadataAdapter({
      read(_authority, operation: HostedMetadataReadOperation) {
        return dispatchHostedRuntimeInternalOperation(registry, state.lease, {
          kind: 'metadata:read',
          operation,
        });
      },
      mutateInLane(_authority, operation: HostedMetadataMutationOperation) {
        return dispatchHostedRuntimeInternalOperation(registry, state.lease, {
          kind: 'metadata:mutate',
          operation,
        });
      },
    }).dispatch({
      userKey: state.identity.userKey,
      generation: state.lease.generation,
    }, request)
  );

  app.get(
    '/api/projects',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (_request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), { kind: 'projects.list' }));
    },
  );
  app.post(
    '/api/projects',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      const result = await dispatchMetadata(hostedRequestState(response), {
        kind: 'project.create',
        body: request.body,
      });
      response.status(201).json(result);
    },
  );
  app.get(
    '/api/projects/:id',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'project.get',
        projectId: request.params.id,
      }));
    },
  );
  app.patch(
    '/api/projects/:id',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'project.patch',
        projectId: request.params.id,
        body: request.body,
      }));
    },
  );
  app.delete(
    '/api/projects/:id',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'project.delete',
        projectId: request.params.id,
      }));
    },
  );
  app.get(
    '/api/projects/:id/conversations',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'conversations.list',
        projectId: request.params.id,
      }));
    },
  );
  app.post(
    '/api/projects/:id/conversations',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      const state = hostedRequestState(response);
      const projectId = hostedRouteParam(request, 'id');
      const result = await dispatchMetadata(state, {
        kind: 'conversation.create',
        projectId,
        body: request.body,
      });
      if ('conversation' in result) {
        const channel = { kind: 'project' as const, projectId };
        try {
          await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'journal:publish',
            channel,
            event: 'conversation-created',
            data: {
              type: 'conversation-created',
              projectId,
              conversationId: result.conversation.id,
              title: result.conversation.title,
              createdAt: result.conversation.createdAt,
            },
          });
        } catch {
          await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
            kind: 'journal:invalidate',
            channel,
          }).catch(() => {});
        }
      }
      response.status(201).json(result);
    },
  );
  app.patch(
    '/api/projects/:id/conversations/:cid',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'conversation.patch',
        projectId: request.params.id,
        conversationId: request.params.cid,
        body: request.body,
      }));
    },
  );
  app.delete(
    '/api/projects/:id/conversations/:cid',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'conversation.delete',
        projectId: request.params.id,
        conversationId: request.params.cid,
      }));
    },
  );
  app.get(
    '/api/projects/:id/conversations/:cid/messages',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'messages.list',
        projectId: request.params.id,
        conversationId: request.params.cid,
      }));
    },
  );
  app.put(
    '/api/projects/:id/conversations/:cid/messages/:mid',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'message.upsert',
        projectId: request.params.id,
        conversationId: request.params.cid,
        messageId: request.params.mid,
        body: request.body,
      }));
    },
  );
  app.get(
    '/api/projects/:id/conversations/:cid/comments',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'comments.list',
        projectId: request.params.id,
        conversationId: request.params.cid,
      }));
    },
  );
  app.post(
    '/api/projects/:id/conversations/:cid/comments',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.status(201).json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'comment.create',
        projectId: request.params.id,
        conversationId: request.params.cid,
        body: request.body,
      }));
    },
  );
  app.get(
    '/api/projects/:id/tabs',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'tabs.get',
        projectId: request.params.id,
      }));
    },
  );
  app.put(
    '/api/projects/:id/tabs',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'tabs.put',
        projectId: request.params.id,
        body: request.body,
      }));
    },
  );
  app.get(
    '/api/projects/:id/checkpoints',
    authenticate,
    rejectAuthorityMetadata,
    exactQuery(['conversationId']),
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'checkpoints.list',
        projectId: request.params.id,
        ...(Object.hasOwn(request.query, 'conversationId')
          ? { conversationId: request.query.conversationId }
          : {}),
      }));
    },
  );
  app.get(
    '/api/projects/:id/checkpoints/:checkpointId',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'checkpoint.get',
        projectId: request.params.id,
        checkpointId: request.params.checkpointId,
      }));
    },
  );
  app.get(
    '/api/projects/:id/checkpoints/:checkpointId/diff',
    authenticate,
    rejectAuthorityMetadata,
    exactQuery(['base']),
    async (request, response) => {
      response.json(await dispatchMetadata(hostedRequestState(response), {
        kind: 'checkpoint.diff',
        projectId: request.params.id,
        checkpointId: request.params.checkpointId,
        ...(Object.hasOwn(request.query, 'base') ? { base: request.query.base } : {}),
      }));
    },
  );

  return dispatchMetadata;
}
