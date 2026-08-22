import { randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { HostedBodyCapacity } from '../hosted-body-capacity.js';
import {
  dispatchHostedRuntimeInternalOperation,
  HostedRuntimeError,
  type HostedRuntimeLease,
  type HostedRuntimeRegistry,
  type HostedRuntimeUploadIntake,
} from '../hosted-runtime-registry.js';
import type { HostedArchiveDownload } from '../hosted-download-stream.js';
import {
  HOSTED_PREVIEW_SCOPE_LIMITS,
  createHostedPreviewScopeRegistry,
  type HostedPreviewScopeGrant,
} from '../hosted-preview-scope.js';
import {
  HOSTED_UPLOAD_LIMITS,
  type HostedMultipartFileDescriptor,
} from '../hosted-upload-adapter.js';
import { buildDocumentPreview } from '../document-preview.js';

const HOSTED_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "worker-src 'none'",
  'sandbox allow-scripts',
].join('; ');
const HOSTED_RAW_FILE_CSP = "default-src 'none'; base-uri 'none'; sandbox";

type HostedContentRequestState = {
  readonly identity: { readonly userKey: string };
  readonly lease: HostedRuntimeLease;
};

type HostedUploadRequestState = {
  readonly intake: HostedRuntimeUploadIntake;
};

export interface HostedContentRouteDependencies {
  readonly authenticate: RequestHandler;
  readonly bodyCapacity: HostedBodyCapacity;
  readonly exactQuery: (allowed: readonly string[]) => RequestHandler;
  readonly hostedJson: RequestHandler;
  readonly noInput: RequestHandler;
  readonly registry: HostedRuntimeRegistry;
  readonly rejectAuthorityBody: RequestHandler;
  readonly rejectAuthorityMetadata: RequestHandler;
  readonly requireMutationAuthority: RequestHandler;
  readonly secureCookies: boolean;
}

export interface HostedContentRouteRegistration {
  dispose(): void;
  revokeGeneration(binding: {
    readonly generation: number;
    readonly userKey: string;
  }): void;
}

export function registerHostedContentRoutes(
  app: Express,
  dependencies: HostedContentRouteDependencies,
): HostedContentRouteRegistration {
  const {
    authenticate,
    bodyCapacity,
    exactQuery,
    hostedJson,
    noInput,
    registry,
    rejectAuthorityBody,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    secureCookies,
  } = dependencies;
  const previewScopes = createHostedPreviewScopeRegistry();
  const dispatchContent = (
    state: HostedContentRequestState,
    request: unknown,
  ) => dispatchHostedRuntimeInternalOperation(registry, state.lease, {
    kind: 'content:dispatch',
    request,
  });
  const parseHostedUpload: RequestHandler = async (request, response, next) => {
    const declaredBytes = request.headers['content-length'];
    if (declaredBytes == null || !/^(?:0|[1-9]\d*)$/u.test(declaredBytes)) {
      next(new HostedRuntimeError('BAD_REQUEST', 'hosted content length is required'));
      return;
    }
    const bytes = Number(declaredBytes);
    if (!Number.isSafeInteger(bytes) || bytes > HOSTED_UPLOAD_LIMITS.requestBytes) {
      next(new HostedRuntimeError('HOSTED_QUOTA_EXCEEDED', 'hosted upload is too large'));
      return;
    }
    let reservation: ReturnType<HostedBodyCapacity['reserve']> | null = null;
    let intake: HostedRuntimeUploadIntake | null = null;
    try {
      const state = requestState(response);
      reservation = bodyCapacity.reserve(state.identity.userKey, bytes);
      intake = await dispatchHostedRuntimeInternalOperation(registry, state.lease, {
        kind: 'upload:begin',
        projectId: routeParam(request, 'id'),
      }) as HostedRuntimeUploadIntake;
      response.locals.hostedUpload = { intake } satisfies HostedUploadRequestState;
    } catch (error) {
      reservation?.release();
      next(error);
      return;
    }

    let released = false;
    let timedOut = false;
    const release = (): void => {
      if (released) return;
      released = true;
      reservation?.release();
      void intake?.cleanup();
    };
    request.once('aborted', release);
    response.once('finish', release);
    response.once('close', release);
    const timer = setTimeout(() => {
      timedOut = true;
      void intake?.cleanup();
      if (!response.headersSent) {
        response.status(408).json({
          error: { code: 'BAD_REQUEST', message: 'hosted upload timed out' },
        });
        response.once('finish', () => request.destroy());
      } else {
        request.destroy();
      }
    }, HOSTED_UPLOAD_LIMITS.timeoutMs);
    timer.unref?.();

    const upload = multer({
      limits: {
        fieldNameSize: 64,
        fieldSize: HOSTED_UPLOAD_LIMITS.dirBytes,
        fields: 1,
        fileSize: HOSTED_UPLOAD_LIMITS.fileBytes,
        files: HOSTED_UPLOAD_LIMITS.files,
        parts: HOSTED_UPLOAD_LIMITS.files + 1,
      },
      storage: multer.diskStorage({
        destination: (_uploadRequest, _file, callback) => callback(null, intake!.stagingRoot),
        filename: (_uploadRequest, _file, callback) => callback(null, randomUUID()),
      }),
    }).array('files', HOSTED_UPLOAD_LIMITS.files);
    upload(request, response, (error) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (error != null) {
        void intake?.cleanup().finally(() => next(error));
        return;
      }
      next();
    });
  };

  app.get(
    '/api/projects/:id/files',
    authenticate,
    rejectAuthorityMetadata,
    exactQuery(['since']),
    async (request, response) => {
      const since = optionalQueryInteger(request, 'since', 0, Number.MAX_SAFE_INTEGER);
      response.json(await dispatchContent(requestState(response), {
        kind: 'files.list',
        projectId: routeParam(request, 'id'),
        ...(since === undefined ? {} : { since }),
      }));
    },
  );
  app.get(
    '/api/projects/:id/files/*file',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      const result = await dispatchContent(requestState(response), {
        kind: 'file.read',
        projectId: routeParam(request, 'id'),
        path: wildcardParam(request, 'file'),
      }) as {
        readonly content: Buffer;
        readonly file: { readonly mime: string; readonly name: string };
      };
      response
        .attachment(result.file.name)
        .set('Cache-Control', 'no-store')
        .set('Content-Security-Policy', HOSTED_RAW_FILE_CSP)
        .set('Content-Type', result.file.mime)
        .set('X-Content-Type-Options', 'nosniff')
        .send(result.content);
    },
  );
  app.post(
    '/api/projects/:id/files',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.status(201).json(await dispatchContent(requestState(response), {
        body: request.body,
        kind: 'file.write',
        projectId: routeParam(request, 'id'),
      }));
    },
  );
  app.post(
    '/api/projects/:id/files/rename',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchContent(requestState(response), {
        body: request.body,
        kind: 'file.rename',
        projectId: routeParam(request, 'id'),
      }));
    },
  );
  app.delete(
    '/api/projects/:id/files/*file',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    noInput,
    async (request, response) => {
      response.json(await dispatchContent(requestState(response), {
        kind: 'file.delete',
        path: wildcardParam(request, 'file'),
        projectId: routeParam(request, 'id'),
      }));
    },
  );
  app.get(
    '/api/projects/:id/search',
    authenticate,
    rejectAuthorityMetadata,
    exactQuery(['q', 'pattern', 'max']),
    async (request, response) => {
      const query = requiredQueryString(request, 'q');
      const pattern = optionalQueryString(request, 'pattern');
      const max = optionalQueryInteger(request, 'max', 1, 1_000);
      response.json(await dispatchContent(requestState(response), {
        kind: 'files.search',
        max: max ?? 200,
        projectId: routeParam(request, 'id'),
        q: query,
        ...(pattern === undefined ? {} : { pattern }),
      }));
    },
  );
  app.get(
    '/api/projects/:id/folders',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchContent(requestState(response), {
        kind: 'folders.list',
        projectId: routeParam(request, 'id'),
      }));
    },
  );
  app.post(
    '/api/projects/:id/folders',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.status(201).json(await dispatchContent(requestState(response), {
        body: request.body,
        kind: 'folder.create',
        projectId: routeParam(request, 'id'),
      }));
    },
  );
  app.delete(
    '/api/projects/:id/folders',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchContent(requestState(response), {
        body: request.body,
        kind: 'folder.delete',
        projectId: routeParam(request, 'id'),
      }));
    },
  );
  app.post(
    '/api/projects/:id/upload',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    parseHostedUpload,
    rejectAuthorityBody,
    async (request, response) => {
      const upload = uploadState(response);
      const result = await upload.intake.finalize({
        fields: request.body as Readonly<Record<string, unknown>>,
        files: multipartFiles(request),
      });
      response.status(201).json(result);
    },
  );
  app.post(
    '/api/projects/:id/files/preview',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      const filePath = exactBodyString(request.body, 'path');
      const result = await dispatchContent(requestState(response), {
        kind: 'file.read',
        path: filePath,
        projectId: routeParam(request, 'id'),
      }) as { readonly content: Buffer; readonly file: { readonly name: string } };
      response.json(await buildDocumentPreview({
        buffer: result.content,
        name: result.file.name,
      }));
    },
  );
  app.post(
    '/api/projects/:id/preview-url',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      const state = requestState(response);
      const projectId = routeParam(request, 'id');
      const file = exactBodyString(request.body, 'file');
      await dispatchContent(state, { kind: 'file.read', path: file, projectId });
      const grant = previewScopes.mint({
        filePath: file,
        generation: state.lease.generation,
        projectId,
        userKey: state.identity.userKey,
      });
      response.set('Set-Cookie', previewCookie(grant, projectId, secureCookies));
      response.json({
        csp: HOSTED_PREVIEW_CSP,
        file,
        iframeSandbox: 'allow-scripts',
        opaqueOrigin: true,
        url: grant.url,
      });
    },
  );
  app.get(
    '/api/projects/:id/preview/:scope/*file',
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      const projectId = routeParam(request, 'id');
      const token = routeParam(request, 'scope');
      const binding = previewScopes.resolve(token, {
        browserProof: previewBrowserProof(request, token),
        projectId,
      });
      if (binding == null) {
        throw new HostedRuntimeError('NOT_FOUND', 'hosted preview was not found');
      }
      const lease = registry.acquire({ userKey: binding.userKey });
      if (lease.generation !== binding.generation) {
        lease.release();
        throw new HostedRuntimeError('NOT_FOUND', 'hosted preview was not found');
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        lease.release();
      };
      response.once('finish', release);
      response.once('close', release);
      const result = await dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'content:dispatch',
        request: {
          kind: 'file.read',
          path: wildcardParam(request, 'file'),
          projectId,
        },
      }) as { readonly content: Buffer; readonly file: { readonly mime: string } };
      response
        .set('Cache-Control', 'no-store')
        .set('Content-Security-Policy', HOSTED_PREVIEW_CSP)
        .set('Content-Type', result.file.mime)
        .set('X-Content-Type-Options', 'nosniff')
        .send(result.content);
    },
  );
  app.get(
    '/api/projects/:id/archive',
    authenticate,
    rejectAuthorityMetadata,
    exactQuery(['root']),
    async (request, response) => {
      const root = optionalQueryString(request, 'root');
      const download = await dispatchHostedRuntimeInternalOperation(
        registry,
        requestState(response).lease,
        {
          kind: 'archive:open',
          projectId: routeParam(request, 'id'),
          ...(root === undefined ? {} : { relativeRoot: root }),
          signal: abortSignalFor(request, response),
        },
      ) as HostedArchiveDownload;
      response.set(download.headers);
      download.pipeTo(response);
    },
  );
  app.get(
    '/api/projects/:id/export/manifest',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      response.json(await dispatchHostedRuntimeInternalOperation(
        registry,
        requestState(response).lease,
        { kind: 'export:manifest', projectId: routeParam(request, 'id') },
      ));
    },
  );
  app.post(
    '/api/artifacts/save',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.status(201).json(await dispatchHostedRuntimeInternalOperation(
        registry,
        requestState(response).lease,
        { kind: 'artifact:save', request: request.body },
      ));
    },
  );
  app.post(
    '/api/artifacts/lint',
    authenticate,
    rejectAuthorityMetadata,
    requireMutationAuthority,
    hostedJson,
    rejectAuthorityBody,
    async (request, response) => {
      response.json(await dispatchHostedRuntimeInternalOperation(
        registry,
        requestState(response).lease,
        { kind: 'artifact:lint', request: request.body },
      ));
    },
  );
  app.get(
    '/api/artifacts/:artifactId/download',
    authenticate,
    rejectAuthorityMetadata,
    noInput,
    async (request, response) => {
      const download = await dispatchHostedRuntimeInternalOperation(
        registry,
        requestState(response).lease,
        {
          artifactId: routeParam(request, 'artifactId'),
          kind: 'artifact:download',
          signal: abortSignalFor(request, response),
        },
      ) as {
        readonly contentType: string;
        readonly fileName: string;
        readonly size: number;
        readonly stream: NodeJS.ReadableStream & { destroy(): void };
      };
      response
        .set('Cache-Control', 'no-store')
        .set('Content-Disposition', `attachment; filename="${download.fileName}"`)
        .set('Content-Length', String(download.size))
        .set('Content-Type', download.contentType)
        .set('X-Content-Type-Options', 'nosniff');
      download.stream.once('error', () => response.destroy());
      response.once('close', () => download.stream.destroy());
      download.stream.pipe(response);
    },
  );

  return Object.freeze({
    dispose(): void {
      previewScopes.dispose();
    },
    revokeGeneration(binding: { readonly generation: number; readonly userKey: string }): void {
      previewScopes.revokeGeneration(binding);
    },
  });
}

function requestState(response: Response): HostedContentRequestState {
  const state = response.locals.hosted as HostedContentRequestState | undefined;
  if (state == null) {
    throw new HostedRuntimeError('HOSTED_AUTH_REQUIRED', 'hosted authentication is required');
  }
  return state;
}

function uploadState(response: Response): HostedUploadRequestState {
  const state = response.locals.hostedUpload as HostedUploadRequestState | undefined;
  if (state == null) {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted upload intake is unavailable');
  }
  return state;
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string') {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted route parameter is invalid');
  }
  return value;
}

function wildcardParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    Array.isArray(value)
    && value.length > 0
    && value.every((segment) => typeof segment === 'string' && segment.length > 0)
  ) return value.join('/');
  throw new HostedRuntimeError('BAD_REQUEST', 'hosted wildcard path is invalid');
}

function exactBodyString(body: unknown, key: string): string {
  if (
    body == null
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !Object.hasOwn(body, key)
  ) {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted request body is invalid');
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted request body is invalid');
  }
  return value;
}

function requiredQueryString(request: Request, key: string): string {
  const value = request.query[key];
  if (typeof value !== 'string') {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted query is invalid');
  }
  return value;
}

function optionalQueryString(request: Request, key: string): string | undefined {
  if (!Object.hasOwn(request.query, key)) return undefined;
  return requiredQueryString(request, key);
}

function optionalQueryInteger(
  request: Request,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = optionalQueryString(request, key);
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted query integer is invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HostedRuntimeError('BAD_REQUEST', 'hosted query integer is invalid');
  }
  return parsed;
}

function multipartFiles(request: Request): readonly HostedMultipartFileDescriptor[] {
  if (!Array.isArray(request.files)) return [];
  return request.files.map((file) => ({
    fieldname: file.fieldname,
    mimetype: file.mimetype,
    originalname: file.originalname,
    path: file.path,
    size: file.size,
  }));
}

function abortSignalFor(request: Request, response: Response): AbortSignal {
  const controller = new AbortController();
  let finished = false;
  response.once('finish', () => { finished = true; });
  const abort = (): void => {
    if (!finished) controller.abort();
  };
  request.once('aborted', abort);
  response.once('close', abort);
  return controller.signal;
}

function previewCookieName(token: string): string {
  return `odpvb_${token.slice('odpv_'.length, 27)}`;
}

function previewCookiePath(projectId: string, token: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/preview/${token}/`;
}

function previewCookie(
  grant: HostedPreviewScopeGrant,
  projectId: string,
  secure: boolean,
): string {
  return [
    `${previewCookieName(grant.token)}=${grant.browserProof}`,
    `Path=${previewCookiePath(projectId, grant.token)}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${HOSTED_PREVIEW_SCOPE_LIMITS.maxTtlMs / 1_000}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function previewBrowserProof(request: Request, token: string): string {
  const cookieName = previewCookieName(token);
  for (const cookie of request.headers.cookie?.split(';') ?? []) {
    const [name, ...value] = cookie.trim().split('=');
    if (name === cookieName) return value.join('=');
  }
  return '';
}
