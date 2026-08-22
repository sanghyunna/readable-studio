import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import {
  API_ERROR_CODES,
  createApiError,
  HOSTED_CSRF_HEADER,
  type ApiErrorCode,
  type HostedProviderId,
} from '@readable-studio/contracts';
import {
  createHostedRuntimeRegistry,
  dispatchHostedRuntimeInternalOperation,
  HostedRuntimeError,
  readHostedRuntimeRegistryCapacity,
  type HostedRuntimeCapacitySnapshot,
  type HostedRuntimeMeasurement,
} from './hosted-runtime-registry.js';
export type {
  HostedRuntimeCapacitySnapshot,
  HostedRuntimeMeasurement,
} from './hosted-runtime-registry.js';
import { HostedArtifactAdapterError } from './hosted-artifact-adapter.js';
import { HostedContentAdapterError } from './hosted-content-adapter.js';
import { HostedContentQuotaError } from './hosted-content-quota.js';
import { HostedDownloadError } from './hosted-download-stream.js';
import { HostedPreviewScopeError } from './hosted-preview-scope.js';
import { HostedUploadError } from './hosted-upload-adapter.js';
import {
  createHostedCatalogueAdapter,
  HostedCatalogueAdapterError,
  type HostedCatalogueSnapshot,
} from './hosted-catalogue-adapter.js';
import {
  createHostedDesignSystemToolAdapter,
  HOSTED_DESIGN_SYSTEM_READ_ENDPOINT,
  HostedDesignSystemToolAdapterError,
} from './hosted-design-system-tool-adapter.js';
import type { HostedEventLimits } from './hosted-event-journal.js';
import { HostedMetadataAdapterError } from './hosted-metadata-adapter.js';
import { HostedRunAdapterError } from './hosted-run-adapter.js';
import {
  startHostedPiTurn,
  type HostedPiTurnDependencies,
  type HostedPiTurnInput,
  type HostedPiTurnResult,
} from './runtimes/hosted-pi-turn.js';
import { sendApiError, statusForError } from './http/response.js';
import { resolveProjectRoot } from './project-root.js';
import { listSkills } from './skills.js';
import { listDesignSystems } from './design-systems.js';
import {
  hasCanonicalHostedRawPath,
  hasHostedClientOwnershipMetadata,
} from './hosted-request-boundary.js';
import { ProjectCheckpointError } from './project-checkpoints.js';
import { createHostedBodyCapacity } from './hosted-body-capacity.js';
import { PreviewHttpError } from './document-preview.js';
import { registerHostedContentRoutes } from './routes/hosted-content.js';
import { registerHostedCatalogueRoutes } from './routes/hosted-catalogue.js';
import {
  exactHostedQuery,
  HostedHttpError,
  hostedApiFailure,
  hostedIdentityState,
  hostedRequestState,
  noHostedInput,
  type HostedIdentityRequestState,
  type HostedRequestState,
} from './routes/hosted-http.js';
import { registerHostedMetadataRoutes } from './routes/hosted-metadata.js';
import {
  hostedProviderDestinations,
  registerHostedProviderRoutes,
  type HostedCsrfState,
} from './routes/hosted-provider.js';
import { registerHostedRunRoutes } from './routes/hosted-runs.js';

export { HOSTED_PROVIDER_CATALOGUE } from './routes/hosted-provider.js';

const MAX_PROVIDER_JSON_BYTES = 128 * 1024;
const MAX_HOSTED_JSON_BYTES = 4 * 1024 * 1024;
const HOSTED_JSON_BODY_TIMEOUT_MS = 30_000;

export interface HostedResolvedIdentity {
  /** Canonical issuer/subject identity produced by the trusted adapter. */
  readonly userKey: string;
  /** Opaque binding for the verified browser cookie or CLI bearer session. */
  readonly sessionKey: string;
  readonly displayName?: string;
}

export interface HostedIdentityMetadata {
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
}

export interface HostedIdentityAdapter {
  resolveIdentity(
    request: Request,
    metadata: HostedIdentityMetadata,
  ): HostedResolvedIdentity | null | Promise<HostedResolvedIdentity | null>;
}

export interface HostedTestComposition {
  readonly resolveIdentity: HostedIdentityAdapter['resolveIdentity'];
  readonly providerBaseUrls?: Partial<Record<HostedProviderId, string>>;
  readonly createEntityId?: (
    kind: 'project' | 'conversation' | 'message',
    userKey: string,
  ) => string;
  readonly createRunId?: (userKey: string) => string;
  readonly startTurn?: (
    input: HostedPiTurnInput,
    dependencies: Pick<HostedPiTurnDependencies, 'designSystemTool'>,
  ) => Promise<HostedPiTurnResult>;
  readonly bodyReadTimeoutMs?: number;
  readonly eventBudgetLimits?: Partial<HostedEventLimits>;
  readonly idleEvictionMs?: number;
  readonly registerRuntimeProbe?: (read: () => HostedRuntimeCapacitySnapshot) => void;
  readonly onRuntimeMeasurement?: (measurement: HostedRuntimeMeasurement) => void;
  readonly shutdownRegistry?: (shutdown: () => Promise<void>) => Promise<void>;
}

export interface StartHostedServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicOrigin: string;
  readonly runtimeRoot?: string;
  /** Trusted immutable resource root; never populated from an HTTP request. */
  readonly resourceRoot?: string;
  readonly identityAdapter?: HostedIdentityAdapter;
  /** Test identities and loopback fixtures are accepted only under NODE_ENV=test. */
  readonly testComposition?: HostedTestComposition;
}

export interface HostedServerHandle {
  readonly url: string;
  readonly server: Server;
  shutdown(): Promise<void>;
}

export async function startHostedServer(
  options: StartHostedServerOptions,
): Promise<HostedServerHandle> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('hosted daemon must bind to loopback behind the public web sidecar');
  }
  const publicOrigin = exactOrigin(options.publicOrigin);
  const testComposition = process.env.NODE_ENV === 'test' ? options.testComposition : undefined;
  if (options.identityAdapter != null && testComposition != null) {
    throw new Error('hosted production and test identity adapters are mutually exclusive');
  }
  const resolveIdentity = options.identityAdapter?.resolveIdentity
    ?? testComposition?.resolveIdentity
    ?? null;
  const providerBaseUrls = hostedProviderDestinations(testComposition?.providerBaseUrls);
  const createRunId = testComposition?.createRunId ?? (() => randomUUID());
  const bodyReadTimeoutMs = testComposition?.bodyReadTimeoutMs ?? HOSTED_JSON_BODY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(bodyReadTimeoutMs)
    || bodyReadTimeoutMs < 1
    || bodyReadTimeoutMs > HOSTED_JSON_BODY_TIMEOUT_MS
  ) throw new Error('hosted body read timeout is invalid');
  const catalogueSnapshot = await loadHostedCatalogue(options.resourceRoot);
  const catalogue = createHostedCatalogueAdapter(catalogueSnapshot);
  const hostedSkills = catalogue.dispatch({ kind: 'skills.list' });
  const hostedDesignSystems = catalogue.dispatch({ kind: 'designSystems.list' });
  if (!('skills' in hostedSkills) || !('designSystems' in hostedDesignSystems)) {
    throw new Error('hosted catalogue initialization failed');
  }
  const projectCatalogueIds = new Set([
    ...hostedSkills.skills.map(({ id }) => id),
    ...hostedDesignSystems.designSystems.map(({ id }) => id),
  ]);
  const skillCatalogueIds = new Set(hostedSkills.skills.map(({ id }) => id));
  const designSystemCatalogueIds = new Set(
    hostedDesignSystems.designSystems.map(({ id }) => id),
  );
  let toolReadUrl: string | null = null;
  let retireGenerationResources = (_binding: {
    readonly generation: number;
    readonly userKey: string;
  }): void => {};
  let contentRoutes: ReturnType<typeof registerHostedContentRoutes> | null = null;
  const registry = createHostedRuntimeRegistry({
    runtimeRoot: path.resolve(options.runtimeRoot ?? '.tmp/hosted/runtime'),
    designSystemCatalogueIds,
    projectCatalogueIds,
    skillCatalogueIds,
    ...(testComposition?.eventBudgetLimits === undefined
      ? {}
      : { eventBudgetLimits: testComposition.eventBudgetLimits }),
    ...(testComposition?.idleEvictionMs === undefined
      ? {}
      : { idleEvictionMs: testComposition.idleEvictionMs }),
    ...(testComposition?.onRuntimeMeasurement === undefined
      ? {}
      : { onMeasurement: testComposition.onRuntimeMeasurement }),
    onGenerationRetired: (binding) => retireGenerationResources(binding),
    ...(testComposition?.createEntityId === undefined
      ? {}
      : { createEntityId: testComposition.createEntityId }),
    startTurn: (input) => {
      if (toolReadUrl == null) {
        throw new HostedRuntimeError(
          'HOSTED_RUNTIME_UNAVAILABLE',
          'hosted design-system tool endpoint is unavailable',
        );
      }
      const dependencies = {
        designSystemTool: {
          readUrl: toolReadUrl,
          mintGrant(binding) {
            const grant = designSystemTool.mintGrant({
              endpoint: HOSTED_DESIGN_SYSTEM_READ_ENDPOINT,
              generation: binding.generation,
              userKey: binding.userKey,
              runId: binding.runId,
              projectId: binding.projectId,
              designSystemId: binding.designSystemId,
            }, { carrierToken: binding.carrierToken });
            return {
              token: grant.token,
              revoke: () => designSystemTool.revoke(grant.token),
            };
          },
        },
      } satisfies Pick<HostedPiTurnDependencies, 'designSystemTool'>;
      return testComposition?.startTurn == null
        ? startHostedPiTurn(input, dependencies)
        : testComposition.startTurn(input, dependencies);
    },
  });
  testComposition?.registerRuntimeProbe?.(() => readHostedRuntimeRegistryCapacity(registry));
  const designSystemTool = createHostedDesignSystemToolAdapter({
    catalogue: hostedDesignSystems.designSystems.map(({ id }) => {
      const files = catalogueSnapshot.designSystemFiles?.[id];
      if (files === undefined) {
        throw new Error('hosted design-system catalogue initialization failed');
      }
      return { id, files };
    }),
    async validateBinding(binding) {
      const lease = registry.acquire({ userKey: binding.userKey });
      if (lease.generation !== binding.generation) {
        lease.release();
        return null;
      }
      try {
        const [project, run] = await Promise.all([
          dispatchHostedRuntimeInternalOperation(registry, lease, {
            kind: 'project:get',
            projectId: binding.projectId,
          }),
          dispatchHostedRuntimeInternalOperation(registry, lease, {
            kind: 'run:get',
            runId: binding.runId,
          }),
        ]);
        if (
          project == null
          || run == null
          || typeof run !== 'object'
          || (run as { projectId?: unknown }).projectId !== binding.projectId
        ) {
          lease.release();
          return null;
        }
        return { release: () => lease.release() };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  });
  retireGenerationResources = ({ generation, userKey }) => {
    designSystemTool.revokeGeneration({ generation, userKey });
    contentRoutes?.revokeGeneration({ generation, userKey });
  };
  const csrf = new Map<string, HostedCsrfState>();
  const bodyCapacity = createHostedBodyCapacity();
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.use((request, response, next) => {
    if (request.method === 'HEAD' || !hasCanonicalHostedRawPath(request)) {
      hostedApiFailure(response, 404, 'HOSTED_ROUTE_NOT_ALLOWED', 'hosted route is not allowed');
      return;
    }
    next();
  });

  app.get('/api/health', noHostedInput, (_request, response) => response.json({ ok: true }));
  app.get('/api/ready', noHostedInput, (_request, response) => response.json({ ready: true }));
  app.get('/api/version', noHostedInput, (_request, response) => response.json({ composition: 'hosted' }));

  const authenticateIdentity: RequestHandler = async (request, response, next) => {
    if (resolveIdentity == null) {
      hostedApiFailure(response, 503, 'HOSTED_AUTH_UNAVAILABLE', 'hosted identity adapter is unavailable');
      return;
    }
    const requestId = randomUUID();
    try {
      const identity = await resolveIdentity(request, {
        method: request.method,
        path: request.path,
        requestId,
      });
      if (identity == null) {
        hostedApiFailure(response, 401, 'HOSTED_AUTH_REQUIRED', 'hosted authentication is required', requestId);
        return;
      }
      validateSessionKey(identity.sessionKey);
      const state: HostedIdentityRequestState = {
        bindingKey: sessionBindingKey(identity),
        identity: Object.freeze({
          userKey: identity.userKey,
          sessionKey: identity.sessionKey,
          ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
        }),
      };
      response.locals.hostedIdentity = state;
      next();
    } catch (error) {
      next(error);
    }
  };

  const acquireRuntime: RequestHandler = (_request, response, next) => {
    try {
      const authenticated = hostedIdentityState(response);
      const lease = registry.acquire({ userKey: authenticated.identity.userKey });
      response.locals.hosted = { ...authenticated, lease } satisfies HostedRequestState;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        lease.release();
      };
      response.once('finish', release);
      response.once('close', release);
      next();
    } catch (error) {
      next(error);
    }
  };
  const authenticate: RequestHandler = (request, response, next) => {
    void authenticateIdentity(request, response, (error?: unknown) => {
      if (error != null) {
        next(error);
        return;
      }
      acquireRuntime(request, response, next);
    });
  };

  const requireMutationAuthority: RequestHandler = (request, response, next) => {
    if (request.get('origin') !== publicOrigin) {
      hostedApiFailure(response, 403, 'HOSTED_ORIGIN_INVALID', 'hosted request origin is invalid');
      return;
    }
    const state = hostedRequestState(response);
    const nonce = csrf.get(state.bindingKey);
    const supplied = request.get(HOSTED_CSRF_HEADER);
    if (
      nonce == null
      || nonce.expiresAt <= Date.now()
      || supplied == null
      || !constantTimeEqual(nonce.token, supplied)
    ) {
      if (nonce != null && nonce.expiresAt <= Date.now()) csrf.delete(state.bindingKey);
      hostedApiFailure(response, 419, 'HOSTED_CSRF_INVALID', 'hosted CSRF token is invalid or expired');
      return;
    }
    next();
  };

  const boundedJson = (maximumBytes: number): RequestHandler => {
    const parse = express.json({ limit: maximumBytes, strict: true });
    return (request, response, next) => {
      const declaredBytes = request.headers['content-length'];
      if (declaredBytes != null && !/^(?:0|[1-9]\d*)$/u.test(declaredBytes)) {
        next(new HostedHttpError('BAD_REQUEST', 'hosted content length is invalid', 400));
        return;
      }
      const bytes = declaredBytes == null ? maximumBytes : Number(declaredBytes);
      if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
        next(new HostedRuntimeError('HOSTED_QUOTA_EXCEEDED', 'hosted request body is too large'));
        return;
      }
      const reservation = bodyCapacity.reserve(hostedRequestState(response).identity.userKey, bytes);
      let released = false;
      let timedOut = false;
      const release = (): void => {
        if (released) return;
        released = true;
        reservation.release();
        request.off('aborted', release);
        response.off('finish', release);
        response.off('close', release);
      };
      const finishReading = (): void => {
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (!response.headersSent) {
          hostedApiFailure(response, 408, 'BAD_REQUEST', 'hosted request body timed out');
          response.once('finish', () => request.destroy());
        } else {
          request.destroy();
        }
      }, bodyReadTimeoutMs);
      timer.unref?.();
      request.once('aborted', release);
      response.once('finish', release);
      response.once('close', release);
      parse(request, response, (error) => {
        finishReading();
        if (timedOut) return;
        next(error);
      });
    };
  };
  const json = boundedJson(MAX_PROVIDER_JSON_BYTES);
  const hostedJson = boundedJson(MAX_HOSTED_JSON_BYTES);
  const rejectAuthorityMetadata: RequestHandler = (request, response, next) => {
    if (hasHostedClientOwnershipMetadata(request)) {
      hostedApiFailure(
        response,
        400,
        'HOSTED_OWNER_FIELD_FORBIDDEN',
        'client ownership fields are not accepted',
      );
      return;
    }
    next();
  };
  const rejectAuthorityBody: RequestHandler = (request, response, next) => {
    if (hasHostedClientOwnershipMetadata(request, true)) {
      hostedApiFailure(
        response,
        400,
        'HOSTED_OWNER_FIELD_FORBIDDEN',
        'client ownership fields are not accepted',
      );
      return;
    }
    next();
  };
  registerHostedProviderRoutes(app, {
    authenticate,
    csrf,
    json,
    noInput: noHostedInput,
    providerBaseUrls,
    publicOrigin,
    registry,
    requireMutationAuthority,
  });
  const dispatchMetadata = registerHostedMetadataRoutes(app, {
    authenticate,
    exactQuery: exactHostedQuery,
    hostedJson,
    noInput: noHostedInput,
    registry,
    rejectAuthorityBody,
    rejectAuthorityMetadata,
    requireMutationAuthority,
  });
  contentRoutes = registerHostedContentRoutes(app, {
    authenticate,
    bodyCapacity,
    exactQuery: exactHostedQuery,
    hostedJson,
    noInput: noHostedInput,
    registry,
    rejectAuthorityBody,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    secureCookies: publicOrigin.startsWith('https:'),
  });
  registerHostedRunRoutes(app, {
    authenticate,
    createRunId,
    dispatchMetadata,
    exactQuery: exactHostedQuery,
    hostedJson,
    noInput: noHostedInput,
    registry,
    rejectAuthorityBody,
    rejectAuthorityMetadata,
    requireMutationAuthority,
  });
  registerHostedCatalogueRoutes(app, {
    authenticateIdentity,
    catalogue,
    designSystemTool,
    noInput: noHostedInput,
    rejectAuthorityMetadata,
  });

  app.use((_request, response) => {
    hostedApiFailure(response, 404, 'HOSTED_ROUTE_NOT_ALLOWED', 'hosted route is not allowed');
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    if (error instanceof HostedHttpError) {
      hostedApiFailure(response, error.status, error.code, error.message);
      return;
    }
    if (
      error instanceof HostedArtifactAdapterError
      || error instanceof HostedContentAdapterError
      || error instanceof HostedContentQuotaError
      || error instanceof HostedDownloadError
      || error instanceof HostedPreviewScopeError
      || error instanceof HostedUploadError
    ) {
      const apiError = createApiError(error.code, error.message);
      sendApiError(response, statusForError(apiError), apiError);
      return;
    }
    if (error instanceof PreviewHttpError) {
      hostedApiFailure(
        response,
        error.statusCode,
        error.statusCode === 413 ? 'HOSTED_QUOTA_EXCEEDED' : 'UNSUPPORTED_MEDIA_TYPE',
        error.message,
      );
      return;
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = [
        'LIMIT_FILE_COUNT',
        'LIMIT_FILE_SIZE',
        'LIMIT_FIELD_VALUE',
        'LIMIT_PART_COUNT',
      ].includes(error.code);
      hostedApiFailure(
        response,
        tooLarge ? 413 : 400,
        tooLarge ? 'HOSTED_QUOTA_EXCEEDED' : 'BAD_REQUEST',
        tooLarge ? 'hosted upload exceeds its limits' : 'hosted multipart body is invalid',
      );
      return;
    }
    if (error instanceof HostedMetadataAdapterError) {
      hostedApiFailure(
        response,
        error.code === 'BAD_REQUEST' ? 400 : 500,
        error.code,
        error.message,
      );
      return;
    }
    if (error instanceof HostedRunAdapterError) {
      hostedApiFailure(
        response,
        error.code === 'BAD_REQUEST' ? 400 : 500,
        error.code,
        error.message,
      );
      return;
    }
    if (error instanceof HostedCatalogueAdapterError) {
      const status = error.code === 'BAD_REQUEST' ? 400 : error.code === 'NOT_FOUND' ? 404 : 500;
      hostedApiFailure(response, status, error.code, error.message);
      return;
    }
    if (error instanceof HostedDesignSystemToolAdapterError) {
      const status = error.code === 'BAD_REQUEST'
        ? 400
        : error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'HOSTED_CAPACITY_EXHAUSTED'
            ? 503
          : error.code === 'INTERNAL_ERROR'
            ? 500
            : 403;
      hostedApiFailure(response, status, error.code, error.message);
      return;
    }
    if (error instanceof ProjectCheckpointError) {
      const code = API_ERROR_CODES.includes(error.code as ApiErrorCode)
        ? error.code as ApiErrorCode
        : 'INTERNAL_ERROR';
      hostedApiFailure(response, code === 'INTERNAL_ERROR' ? 500 : error.status, code, error.message);
      return;
    }
    if (error instanceof HostedRuntimeError) {
      const apiError = createApiError(error.code, error.message);
      sendApiError(response, statusForError(apiError), apiError);
      return;
    }
    if (isJsonBodyError(error)) {
      const tooLarge = error.type === 'entity.too.large';
      hostedApiFailure(
        response,
        tooLarge ? 413 : 400,
        tooLarge ? 'HOSTED_QUOTA_EXCEEDED' : 'BAD_REQUEST',
        tooLarge ? 'hosted request body is too large' : 'hosted request body is invalid',
      );
      return;
    }
    hostedApiFailure(response, 500, 'INTERNAL_ERROR', 'hosted request failed');
  });

  const server = await listen(app, options.port ?? 7456, host);
  const address = server.address();
  if (address == null || typeof address === 'string') {
    await registry.shutdown();
    throw new Error('hosted server did not bind a TCP address');
  }
  const url = `http://${host === 'localhost' ? '127.0.0.1' : host}:${address.port}`;
  toolReadUrl = `${url}${HOSTED_DESIGN_SYSTEM_READ_ENDPOINT}`;
  let shutdownPromise: Promise<void> | null = null;
  return {
    server,
    url,
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        csrf.clear();
        designSystemTool.dispose();
        contentRoutes?.dispose();
        const results = await Promise.allSettled([
          testComposition?.shutdownRegistry?.(() => registry.shutdown()) ?? registry.shutdown(),
          closeServer(server),
        ]);
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length > 0) {
          throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'hosted shutdown failed');
        }
      })();
      return shutdownPromise;
    },
  };
}

function exactOrigin(input: string): string {
  const parsed = new URL(input);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.origin !== input
    || parsed.username !== ''
    || parsed.password !== ''
  ) {
    throw new Error('hosted public origin must be an exact HTTP(S) origin');
  }
  return parsed.origin;
}

function validateSessionKey(value: string): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.alloc(0);
  if (
    bytes.length < 1
    || bytes.length > 1_024
    || bytes.toString('utf8') !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new HostedHttpError('HOSTED_AUTH_INVALID', 'hosted identity session is invalid', 401);
  }
}

function sessionBindingKey(identity: HostedResolvedIdentity): string {
  return `${Buffer.byteLength(identity.userKey, 'utf8')}:${identity.userKey}${identity.sessionKey}`;
}

function constantTimeEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function isJsonBodyError(error: unknown): error is { type?: string } {
  return error instanceof SyntaxError
    || (typeof error === 'object' && error != null && 'type' in error);
}

function listen(app: express.Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error == null ? resolve() : reject(error));
    server.closeAllConnections();
  });
}

async function loadHostedCatalogue(resourceRoot?: string): Promise<HostedCatalogueSnapshot> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolveProjectRoot(moduleDir);
  const root = exactResourceRoot(
    resourceRoot ?? process.env.READABLE_RESOURCE_ROOT ?? workspaceRoot,
  );
  const skillsRoot = path.join(root, 'skills');
  const designSystemsRoot = path.join(root, 'design-systems');
  const skills = (await listSkills([skillsRoot])).map((skill) => ({
    ...skill,
    source: 'built-in' as const,
  }));
  const designSystems = await listDesignSystems(designSystemsRoot, {
    source: 'built-in',
    isEditable: false,
    defaultStatus: 'published',
  });
  const skillFiles = Object.fromEntries(skills.map((skill) => [
    skill.id,
    collectCatalogueFiles(skillsRoot, skill.dir),
  ]));
  const designSystemFiles = Object.fromEntries(designSystems.map(({ id }) => [
    id,
    collectDesignSystemToolFiles(designSystemsRoot, id),
  ]));
  return {
    agents: [{ id: 'pi', name: 'Pi', source: 'built-in' }],
    skills,
    skillFiles,
    designSystems,
    designSystemFiles,
  };
}

function collectDesignSystemToolFiles(
  root: string,
  id: string,
): Array<{ path: string; content: string }> {
  const exactRoot = fs.realpathSync(root);
  const directory = path.join(exactRoot, id);
  const directoryStat = fs.lstatSync(directory);
  const exactDirectory = fs.realpathSync(directory);
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || !sameServerPath(directory, exactDirectory)
    || !sameServerPath(path.dirname(exactDirectory), exactRoot)
  ) throw new Error('hosted design-system catalogue escaped its immutable root');
  const manifestContent = readDesignSystemToolFile(exactDirectory, 'manifest.json');
  let manifest: unknown;
  try { manifest = JSON.parse(manifestContent); } catch {
    throw new Error('hosted design-system manifest is invalid');
  }
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('hosted design-system manifest is invalid');
  }
  const record = manifest as Record<string, unknown>;
  const paths = new Set<string>(['manifest.json']);
  const add = (value: unknown): void => {
    if (typeof value === 'string') paths.add(value);
  };
  if (record.files != null && typeof record.files === 'object' && !Array.isArray(record.files)) {
    for (const value of Object.values(record.files)) add(value);
  }
  add(record.usage);
  add(record.componentsManifest);
  if (
    record.preview != null
    && typeof record.preview === 'object'
    && !Array.isArray(record.preview)
    && Array.isArray((record.preview as Record<string, unknown>).pages)
  ) {
    for (const page of (record.preview as { pages: unknown[] }).pages) {
      if (page != null && typeof page === 'object' && !Array.isArray(page)) {
        add((page as Record<string, unknown>).path);
      }
    }
  }
  if (
    record.sourceFiles != null
    && typeof record.sourceFiles === 'object'
    && !Array.isArray(record.sourceFiles)
  ) {
    for (const value of Object.values(record.sourceFiles)) add(value);
  }
  if (Array.isArray(record.fonts)) {
    for (const font of record.fonts) {
      if (font != null && typeof font === 'object' && !Array.isArray(font)) {
        add((font as Record<string, unknown>).file);
      }
    }
  }
  if (paths.size > 128) throw new Error('hosted design-system manifest is too large');
  return [...paths].sort().map((relativePath) => ({
    path: relativePath,
    content: relativePath === 'manifest.json'
      ? manifestContent
      : readDesignSystemToolFile(exactDirectory, relativePath),
  }));
}

function readDesignSystemToolFile(root: string, relativePath: string): string {
  if (
    Buffer.byteLength(relativePath, 'utf8') < 1
    || Buffer.byteLength(relativePath, 'utf8') > 1_024
    || relativePath.startsWith('/')
    || relativePath.includes('\\')
    || /^[A-Za-z]:/u.test(relativePath)
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) throw new Error('hosted design-system manifest path is invalid');
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('hosted design-system catalogue contains a link');
  }
  const stat = fs.statSync(current);
  const resolved = fs.realpathSync(current);
  const relative = path.relative(root, resolved);
  if (
    !stat.isFile()
    || stat.size > 4 * 1024 * 1024
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
  ) throw new Error('hosted design-system catalogue file is invalid');
  const content = fs.readFileSync(resolved);
  const decoded = content.toString('utf8');
  if (!content.equals(Buffer.from(decoded, 'utf8'))) {
    throw new Error('hosted design-system catalogue file is not UTF-8');
  }
  return decoded;
}

function exactResourceRoot(input: string): string {
  const requested = path.resolve(input);
  const stat = fs.lstatSync(requested);
  const resolved = fs.realpathSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameServerPath(requested, resolved)) {
    throw new Error('hosted resource root must be an exact directory');
  }
  return resolved;
}

function collectCatalogueFiles(root: string, directory: string): Array<{
  path: string;
  kind: 'directory' | 'file';
  size: number | null;
}> {
  const exactRoot = fs.realpathSync(root);
  const exactDirectory = fs.realpathSync(directory);
  const relativeDirectory = path.relative(exactRoot, exactDirectory);
  if (
    path.isAbsolute(relativeDirectory)
    || relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${path.sep}`)
  ) throw new Error('hosted skill catalogue escaped its immutable root');
  const files: Array<{ path: string; kind: 'directory' | 'file'; size: number | null }> = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('hosted skill catalogue contains a link');
      const file = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        files.push({ path: relative, kind: 'directory', size: null });
        if (files.length > 500) throw new Error('hosted skill catalogue is too large');
        visit(file, relative);
      } else if (entry.isFile()) {
        files.push({ path: relative, kind: 'file', size: fs.statSync(file).size });
        if (files.length > 500) throw new Error('hosted skill catalogue is too large');
      }
    }
  };
  visit(exactDirectory, '');
  return files;
}

function sameServerPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
