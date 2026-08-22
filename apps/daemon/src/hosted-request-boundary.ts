import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createApiErrorResponse,
  type ApiErrorCode,
  type HostedAuthContext,
} from '@readable-studio/contracts';

export interface HostedIdentityRequest {
  readonly method: string;
  readonly path: string;
  readonly requestId: string;
}

export type HostedIdentityResolver = (
  request: Request,
  metadata: HostedIdentityRequest,
) => HostedIdentity | null | Promise<HostedIdentity | null>;

export type HostedIdentity = Omit<HostedAuthContext, 'requestId'>;

export interface HostedRouteRule {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly probe?: boolean;
}

export interface HostedRequestBoundaryOptions {
  /**
   * PR01 only exposes the boundary through an explicit test composition.
   * Production startup has no identity adapter yet; later hosted PRs replace
   * this seam with the real user-runtime adapter before enabling data routes.
   * The runtime test guard also requires NODE_ENV=test, so this composition
   * cannot be activated by a production launch configuration.
   */
  readonly testComposition?: boolean;
  readonly resolveIdentity?: HostedIdentityResolver;
}

export interface HostedExcludedRoute {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

const OWNER_FIELD_NAMES = new Set([
  'accountid',
  'accountkey',
  'namespaceid',
  'ownerid',
  'ownerkey',
  'storagekey',
  'storageid',
  'tenantid',
  'tenantkey',
  'userid',
  'userkey',
]);

const GENERIC_OWNER_FIELD_NAMES = new Set([
  'account',
  'namespace',
  'owner',
  'storage',
  'tenant',
  'user',
]);

const OWNER_HEADER_NAMES = new Set([
  'account',
  'namespace',
  'owner',
  'storage',
  'tenant',
  'user',
  'x-account-id',
  'x-namespace',
  'x-owner-id',
  'x-owner-key',
  'x-storage-key',
  'x-tenant-id',
  'x-user-id',
  'x-user-key',
]);

const WINDOWS_DEVICE_NAMES = new Set([
  'aux',
  'con',
  'nul',
  'prn',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * The initial hosted characterization. Local-only capabilities intentionally
 * do not appear here; future hosted PRs may add a route only with its own
 * scoped implementation and tests.
 */
export const HOSTED_ROUTE_ALLOWLIST: readonly HostedRouteRule[] = Object.freeze([
  { method: 'GET', path: '/health', probe: true },
  { method: 'GET', path: '/ready', probe: true },
  { method: 'GET', path: '/version', probe: true },
  { method: 'GET', path: '/api/health', probe: true },
  { method: 'GET', path: '/api/ready', probe: true },
  { method: 'GET', path: '/api/version', probe: true },
  { method: 'GET', path: '/api/projects' },
  { method: 'POST', path: '/api/projects' },
  { method: 'GET', path: '/api/projects/:id' },
  { method: 'PATCH', path: '/api/projects/:id' },
  { method: 'DELETE', path: '/api/projects/:id' },
  { method: 'GET', path: '/api/projects/:id/events' },
  { method: 'GET', path: '/api/projects/:id/conversations' },
  { method: 'POST', path: '/api/projects/:id/conversations' },
  { method: 'PATCH', path: '/api/projects/:id/conversations/:cid' },
  { method: 'DELETE', path: '/api/projects/:id/conversations/:cid' },
  { method: 'GET', path: '/api/projects/:id/conversations/:cid/messages' },
  { method: 'PUT', path: '/api/projects/:id/conversations/:cid/messages/:mid' },
  { method: 'GET', path: '/api/projects/:id/conversations/:cid/comments' },
  { method: 'POST', path: '/api/projects/:id/conversations/:cid/comments' },
  { method: 'GET', path: '/api/projects/:id/tabs' },
  { method: 'PUT', path: '/api/projects/:id/tabs' },
  { method: 'GET', path: '/api/projects/:id/checkpoints' },
  { method: 'GET', path: '/api/projects/:id/checkpoints/:checkpointId' },
  { method: 'GET', path: '/api/projects/:id/checkpoints/:checkpointId/diff' },
  { method: 'GET', path: '/api/projects/:id/files' },
  { method: 'GET', path: '/api/projects/:id/files/*' },
  { method: 'POST', path: '/api/projects/:id/files' },
  { method: 'POST', path: '/api/projects/:id/files/rename' },
  { method: 'GET', path: '/api/projects/:id/search' },
  { method: 'GET', path: '/api/projects/:id/folders' },
  { method: 'POST', path: '/api/projects/:id/folders' },
  { method: 'DELETE', path: '/api/projects/:id/folders' },
  { method: 'GET', path: '/api/projects/:id/files/:name/preview' },
  { method: 'DELETE', path: '/api/projects/:id/files/:name' },
  { method: 'GET', path: '/api/projects/:id/preview-url' },
  { method: 'GET', path: '/api/projects/:id/preview/*' },
  { method: 'GET', path: '/api/projects/:id/archive' },
  { method: 'GET', path: '/api/projects/:id/export/manifest' },
  { method: 'POST', path: '/api/exports/standalone-html' },
  { method: 'POST', path: '/api/artifacts/save' },
  { method: 'POST', path: '/api/artifacts/lint' },
  { method: 'GET', path: '/api/runs' },
  { method: 'POST', path: '/api/runs' },
  { method: 'GET', path: '/api/runs/:id' },
  { method: 'GET', path: '/api/runs/:id/events' },
  { method: 'POST', path: '/api/runs/:id/cancel' },
  { method: 'POST', path: '/api/runs/:id/feedback' },
  { method: 'GET', path: '/api/runs/:id/agui' },
  { method: 'GET', path: '/api/runs/:id/genui' },
  { method: 'GET', path: '/api/projects/:projectId/genui' },
  { method: 'GET', path: '/api/runs/:runId/genui/:surfaceId' },
  { method: 'POST', path: '/api/runs/:runId/genui/:surfaceId/respond' },
  { method: 'POST', path: '/api/projects/:projectId/genui/:surfaceId/revoke' },
  { method: 'POST', path: '/api/projects/:projectId/genui/prefill' },
  { method: 'POST', path: '/api/chat' },
  { method: 'GET', path: '/api/agents/catalog' },
  { method: 'GET', path: '/api/skills' },
  { method: 'GET', path: '/api/skills/:id' },
  { method: 'GET', path: '/api/design-systems' },
  { method: 'GET', path: '/api/design-systems/:id' },
  { method: 'GET', path: '/api/skills/:id/files' },
    { method: 'POST', path: '/api/tools/design-systems/read' },
]);

/**
 * Route classes captured from the current daemon route trace. These are
 * explicit exclusions, not an alternate authorization mechanism.
 */
export const HOSTED_ROUTE_CHARACTERIZATION: Readonly<{
  allowed: readonly HostedRouteRule[];
  excluded: readonly HostedExcludedRoute[];
}> = Object.freeze({
  allowed: HOSTED_ROUTE_ALLOWLIST,
  excluded: Object.freeze([
    { method: 'GET', path: '/api/agents', reason: 'probes local executables' },
    { method: 'GET', path: '/api/app-config', reason: 'local/browser configuration' },
    { method: 'PUT', path: '/api/app-config', reason: 'local/browser configuration' },
    { method: 'GET', path: '/api/projects/:id/raw/*', reason: 'ambient-origin artifact access' },
    { method: 'GET', path: '/artifacts/*', reason: 'raw shared artifact surface' },
    { method: 'GET', path: '/api/projects/:id/export/*', reason: 'raw exported file surface' },
    { method: 'POST', path: '/api/projects/:id/export/pdf', reason: 'desktop-only native export' },
    { method: 'POST', path: '/api/projects/:id/archive/batch', reason: 'unbounded archive expansion' },
    { method: 'POST', path: '/api/upload', reason: 'global upload root before hosted limits' },
    { method: 'POST', path: '/api/projects/:id/upload', reason: 'project upload before hosted storage limits' },
    { method: 'GET', path: '/api/projects/:id/terminals', reason: 'terminal/process capability' },
    { method: 'POST', path: '/api/projects/:id/terminals', reason: 'terminal/process capability' },
    { method: 'GET', path: '/api/projects/:id/terminals/:tid/stream', reason: 'terminal/process capability' },
    { method: 'POST', path: '/api/projects/:id/terminals/:tid/stdin', reason: 'terminal/process capability' },
    { method: 'POST', path: '/api/projects/:id/terminals/:tid/resize', reason: 'terminal/process capability' },
    { method: 'POST', path: '/api/projects/:id/terminals/:tid/kill', reason: 'terminal/process capability' },
    { method: 'DELETE', path: '/api/projects/:id/terminals/:tid', reason: 'terminal/process capability' },
    { method: 'POST', path: '/api/tools/media/generate', reason: 'credentialed media capability' },
    { method: 'POST', path: '/api/dialog/open-folder', reason: 'native folder picker' },
    { method: 'GET', path: '/api/mcp/*', reason: 'local MCP configuration/install/OAuth' },
    { method: 'POST', path: '/api/mcp/*', reason: 'local MCP configuration/install/OAuth' },
    { method: 'PUT', path: '/api/mcp/*', reason: 'local MCP configuration/install/OAuth' },
    { method: 'DELETE', path: '/api/mcp/*', reason: 'local MCP configuration/install/OAuth' },
    { method: 'GET', path: '/api/plugins/*', reason: 'local plugin/package administration' },
    { method: 'POST', path: '/api/plugins/*', reason: 'local plugin/package administration' },
    { method: 'PUT', path: '/api/plugins/*', reason: 'local plugin/package administration' },
    { method: 'PATCH', path: '/api/plugins/*', reason: 'local plugin/package administration' },
    { method: 'DELETE', path: '/api/plugins/*', reason: 'local plugin/package administration' },
    { method: 'GET', path: '/api/applied-plugins/*', reason: 'local plugin/package administration' },
    { method: 'POST', path: '/api/applied-plugins/*', reason: 'local plugin/package administration' },
    { method: 'DELETE', path: '/api/applied-plugins/*', reason: 'local plugin/package administration' },
    { method: 'POST', path: '/api/skills/install', reason: 'runtime package/resource installation' },
    { method: 'POST', path: '/api/design-systems/import/github', reason: 'unbounded external import' },
    { method: 'POST', path: '/api/projects/:id/working-dir', reason: 'local working-directory selection' },
    { method: 'GET', path: '/api/project-locations', reason: 'local project-location configuration' },
    { method: 'PUT', path: '/api/project-locations', reason: 'local project-location configuration' },
    { method: 'POST', path: '/api/project-locations/*', reason: 'local project-location scanning' },
    { method: 'POST', path: '/api/proxy/*', reason: 'browser-direct provider proxy' },
    { method: 'POST', path: '/api/system/open-external', reason: 'native external opener' },
    { method: 'GET', path: '/api/system/fonts', reason: 'host system capability' },
    { method: 'POST', path: '/api/research/search', reason: 'local/external research provider' },
    { method: 'GET', path: '/api/deploy/*', reason: 'local deployment configuration' },
    { method: 'PUT', path: '/api/deploy/*', reason: 'local deployment configuration' },
    { method: 'POST', path: '/api/deploy/*', reason: 'local deployment side effect' },
    { method: 'GET', path: '/api/routines/*', reason: 'local automation scheduler' },
    { method: 'POST', path: '/api/routines/*', reason: 'local automation scheduler' },
    { method: 'PATCH', path: '/api/routines/*', reason: 'local automation scheduler' },
    { method: 'DELETE', path: '/api/routines/*', reason: 'local automation scheduler' },
    { method: 'GET', path: '/api/automation-templates/*', reason: 'local automation scheduler' },
    { method: 'GET', path: '/api/xai/*', reason: 'local provider OAuth/search' },
    { method: 'POST', path: '/api/xai/*', reason: 'local provider OAuth/search' },
    { method: 'POST', path: '/api/agents/:agentId/oauth-launch', reason: 'local provider OAuth launcher' },
    { method: 'POST', path: '/api/projects/:id/plugins/*', reason: 'local plugin/package administration' },
    { method: 'POST', path: '/api/projects/:id/finalize/*', reason: 'local provider finalization' },
    { method: 'POST', path: '/api/projects/:id/deploy/*', reason: 'local deployment side effect' },
    { method: 'POST', path: '/api/projects/:id/deploy', reason: 'local deployment side effect' },
    { method: 'DELETE', path: '/api/projects/:id/raw/*', reason: 'ambient-origin artifact access' },
    { method: 'OPTIONS', path: '/api/projects/:id/raw/*', reason: 'ambient-origin artifact preflight' },
    { method: 'POST', path: '/api/import/*', reason: 'local folder import' },
    { method: 'POST', path: '/api/provider/*', reason: 'local provider configuration/probing' },
    { method: 'POST', path: '/api/test/*', reason: 'local provider connection probing' },
    { method: 'GET', path: '/api/desktop/*', reason: 'desktop-only control plane' },
    { method: 'POST', path: '/api/desktop/*', reason: 'desktop-only control plane' },
    { method: 'GET', path: '/api/daemon/*', reason: 'local daemon administration' },
    { method: 'POST', path: '/api/daemon/*', reason: 'local daemon administration' },
    { method: 'GET', path: '/api/metrics', reason: 'local daemon metrics' },
    { method: 'GET', path: '/api/critique/*', reason: 'local critique administration' },
    { method: 'GET', path: '/api/analytics/*', reason: 'local analytics configuration' },
    { method: 'POST', path: '/api/analytics/*', reason: 'local analytics configuration' },
    { method: 'POST', path: '/api/observability/*', reason: 'local analytics ingestion' },
    { method: 'GET', path: '/api/automation-source-packets', reason: 'local automation administration' },
    { method: 'GET', path: '/api/automation-source-packets/:id', reason: 'local automation administration' },
    { method: 'POST', path: '/api/automation-ingestions', reason: 'local automation administration' },
    { method: 'GET', path: '/api/automation-proposals', reason: 'local automation administration' },
    { method: 'POST', path: '/api/automation-proposals', reason: 'local automation administration' },
    { method: 'GET', path: '/api/automation-proposals/:id', reason: 'local automation administration' },
    { method: 'POST', path: '/api/automation-proposals/:id/*', reason: 'local automation administration' },
    { method: 'GET', path: '/api/memory/*', reason: 'local memory administration' },
    { method: 'POST', path: '/api/memory/*', reason: 'local memory administration' },
    { method: 'PATCH', path: '/api/memory/*', reason: 'local memory administration' },
    { method: 'PUT', path: '/api/memory/*', reason: 'local memory administration' },
    { method: 'DELETE', path: '/api/memory/*', reason: 'local memory administration' },
    { method: 'POST', path: '/api/social-share', reason: 'local/share integration' },
    { method: 'GET', path: '/api/templates/*', reason: 'local template administration' },
    { method: 'POST', path: '/api/templates', reason: 'local template administration' },
    { method: 'DELETE', path: '/api/templates/*', reason: 'local template administration' },
    { method: 'GET', path: '/api/design-templates/*', reason: 'local template administration' },
    { method: 'POST', path: '/api/design-systems/*', reason: 'local design-system administration' },
    { method: 'PATCH', path: '/api/design-systems/*', reason: 'local design-system administration' },
    { method: 'DELETE', path: '/api/design-systems/*', reason: 'local design-system administration' },
    { method: 'POST', path: '/api/skills/import', reason: 'local skill administration' },
    { method: 'PUT', path: '/api/skills/:id', reason: 'local skill administration' },
    { method: 'DELETE', path: '/api/skills/:id', reason: 'local skill administration' },
    { method: 'GET', path: '/api/amr/*', reason: 'local AMR provider administration' },
    { method: 'GET', path: '/api/integrations/vela/*', reason: 'local provider administration' },
    { method: 'POST', path: '/api/integrations/vela/*', reason: 'local provider administration' },
    { method: 'GET', path: '/api/marketplaces/*', reason: 'local plugin marketplace administration' },
    { method: 'POST', path: '/api/marketplaces/*', reason: 'local plugin marketplace administration' },
    { method: 'DELETE', path: '/api/marketplaces/*', reason: 'local plugin marketplace administration' },
    { method: 'GET', path: '/api/applied-plugins', reason: 'local plugin/package administration' },
    { method: 'GET', path: '/api/projects/:projectId/applied-plugins', reason: 'local plugin/package administration' },
    { method: 'POST', path: '/api/applied-plugins/*', reason: 'local plugin/package administration' },
    { method: 'GET', path: '/api/atoms/*', reason: 'local atom administration' },
    { method: 'GET', path: '/api/craft/*', reason: 'local craft administration' },
    { method: 'GET', path: '/api/codex-pets/*', reason: 'local desktop decoration' },
    { method: 'GET', path: '/api/asset-cache', reason: 'local static-resource cache' },
    { method: 'GET', path: '/api/projects/:id/deployments', reason: 'local deployment state' },
    { method: 'POST', path: '/api/projects/:id/handoff', reason: 'local handoff integration' },
    { method: 'GET', path: '/api/projects/:id/design-system-package-audit', reason: 'local design-system audit' },
    { method: 'GET', path: '/api/design-systems/:id/preview', reason: 'local design-system preview' },
    { method: 'GET', path: '/api/design-systems/:id/showcase', reason: 'local design-system showcase' },
    { method: 'GET', path: '/api/skills/:id/example', reason: 'local skill example surface' },
    { method: 'GET', path: '/api/skills/:id/assets/*', reason: 'local skill asset surface' },
    { method: 'POST', path: '/api/tools/media/*', reason: 'credentialed media capability' },
    { method: 'GET', path: '/api/runs/:runId/devloop-iterations', reason: 'local run replay/debug history' },
    { method: 'POST', path: '/api/runs/:runId/replay', reason: 'local run replay/debug control' },
    { method: 'POST', path: '/api/projects/:id/conversations/:cid/rollback', reason: 'local rollback control' },
    { method: 'POST', path: '/api/projects/:id/conversations/:cid/agent-rollback-request', reason: 'local rollback control' },
    { method: 'POST', path: '/api/projects/:id/conversations/:cid/agent-rollback-execute', reason: 'local rollback control' },
    { method: 'PATCH', path: '/api/projects/:id/conversations/:cid/comments/:commentId', reason: 'local comment administration' },
    { method: 'DELETE', path: '/api/projects/:id/conversations/:cid/comments/:commentId', reason: 'local comment administration' },
    { method: 'GET', path: '/api/design-systems/generation-jobs/:jobId', reason: 'local design-system generation state' },
    { method: 'GET', path: '/api/design-systems/:id/revisions', reason: 'local design-system revision state' },
    { method: 'GET', path: '/api/design-systems/:id/files', reason: 'local design-system file administration' },
    { method: 'GET', path: '/api/design-systems/:id/file', reason: 'local design-system file administration' },
    { method: 'GET', path: '/api/projects/:projectId/critique/:runId/artifact', reason: 'local critique administration' },
    { method: 'POST', path: '/api/projects/:projectId/critique/:runId/interrupt', reason: 'local critique administration' },
    { method: 'POST', path: '/api/projects/:id/deployments/:deploymentId/check-link', reason: 'local deployment state' },
    { method: 'GET', path: '/*splat', reason: 'static SPA fallback' },
  ]),
});

const contexts = new WeakMap<Request, HostedAuthContext>();

export function validateHostedAuthContext(
  context: HostedAuthContext | null | undefined,
): context is HostedAuthContext {
  if (context == null || typeof context !== 'object') return false;
  if (!isNonEmptySafeText(context.userKey, 256)) return false;
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/u.test(context.storageKey)) return false;
  if (context.storageKey.includes('..')) return false;
  if (WINDOWS_DEVICE_NAMES.has(context.storageKey)) return false;
  if (!isNonEmptySafeText(context.requestId, 256)) return false;
  return context.displayName === undefined || isSafeText(context.displayName, 256);
}

export function getHostedAuthContext(request: Request): HostedAuthContext | null {
  return contexts.get(request) ?? null;
}

export function isHostedRouteAllowed(
  method: string,
  path: string,
): boolean {
  return findHostedRouteRule(method, path) != null;
}

export function findHostedRouteRule(
  method: string,
  path: string,
): HostedRouteRule | undefined {
  const normalizedPath = normalizePath(path);
  if (normalizedPath == null) return undefined;
  const normalizedMethod = method.toUpperCase();
  return HOSTED_ROUTE_ALLOWLIST.find(
    (rule) => rule.method === normalizedMethod && matchesPath(rule.path, normalizedPath),
  );
}

export function createHostedRequestBoundary(
  options: HostedRequestBoundaryOptions,
): RequestHandler {
  return async function hostedRequestBoundary(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const requestPathValue = requestPath(request);
    const rule = requestPathValue == null
      ? undefined
      : findHostedRouteRule(request.method, requestPathValue);

    if (requestPathValue == null || rule == null) {
      reject(response, 404, 'HOSTED_ROUTE_NOT_ALLOWED', 'hosted route is not enabled');
      return;
    }
    if (rule.probe) {
      next();
      return;
    }

    if (hasClientOwnershipMetadata(request)) {
      reject(response, 400, 'HOSTED_OWNER_FIELD_FORBIDDEN', 'client ownership fields are not accepted');
      return;
    }
    if (
      options.testComposition !== true
      || process.env.NODE_ENV !== 'test'
      || options.resolveIdentity == null
    ) {
      reject(response, 503, 'HOSTED_AUTH_UNAVAILABLE', 'hosted identity is not configured');
      return;
    }

    const metadata: HostedIdentityRequest = {
      method: request.method.toUpperCase(),
      path: requestPathValue,
      requestId: randomUUID(),
    };
    try {
      const context = await options.resolveIdentity(request, metadata);
      if (context == null) {
        reject(response, 401, 'HOSTED_AUTH_REQUIRED', 'authenticated hosted identity is required');
        return;
      }
      const boundaryContext = { ...context, requestId: metadata.requestId };
      if (!validateHostedAuthContext(boundaryContext)) {
        reject(response, 500, 'HOSTED_AUTH_INVALID', 'hosted identity adapter returned an invalid identity');
        return;
      }
      const immutableContext = Object.freeze(boundaryContext);
      contexts.set(request, immutableContext);
      next();
    } catch {
      reject(response, 500, 'HOSTED_AUTH_INVALID', 'hosted identity could not be resolved');
    }
  };
}

/**
 * Mount after the JSON/multipart parsers. The route/auth boundary itself is
 * intentionally mounted before parsers so denied requests cannot spend parser
 * work or memory before being rejected.
 */
export function createHostedRequestBodyGuard(): RequestHandler {
  return function hostedRequestBodyGuard(request, response, next): void {
    if (getHostedAuthContext(request) != null && containsOwnershipField(request.body)) {
      reject(response, 400, 'HOSTED_OWNER_FIELD_FORBIDDEN', 'client ownership fields are not accepted');
      return;
    }
    next();
  };
}

function requestPath(request: Request): string | null {
  const originalUrl = request.originalUrl || request.url || request.path;
  const rawPath = originalUrl.split('?', 1)[0] ?? '';
  const normalized = normalizePath(rawPath);
  return normalized == null || containsPathOwnershipMetadata(normalized) ? null : normalized;
}

/** Validate the untouched request target before Express can decode or normalize route aliases. */
export function hasCanonicalHostedRawPath(request: Request): boolean {
  const originalUrl = request.originalUrl || request.url || request.path;
  const rawPath = originalUrl.split('?', 1)[0] ?? '';
  return normalizePath(rawPath) === rawPath || hasCanonicalHostedContentTail(rawPath);
}

function hasCanonicalHostedContentTail(rawPath: string): boolean {
  if (
    !rawPath.startsWith('/')
    || rawPath.length > 2_048
    || rawPath.includes('\\')
    || rawPath.includes('//')
    || /[\u0000-\u001f\u007f]/u.test(rawPath)
    || rawPath.endsWith('/')
  ) return false;
  const match = /^\/api\/projects\/([A-Za-z0-9._-]{1,128})\/(?:files|preview\/odpv_[A-Za-z0-9_-]{43})\/(.+)$/u.exec(rawPath);
  if (match == null) return false;
  return match[2]!.split('/').every((segment) => {
    if (segment === '' || !segment.includes('%')) return segment !== '.' && segment !== '..';
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.'
        && decoded !== '..'
        && !decoded.includes('/')
        && !decoded.includes('\\')
        && !decoded.includes('%')
        && !/[\u0000-\u001f\u007f]/u.test(decoded)
        && encodeURIComponent(decoded) === segment;
    } catch {
      return false;
    }
  });
}

function normalizePath(path: string): string | null {
  if (!path.startsWith('/') || path.includes('\\') || path.includes('//')) return null;
  if (path.length > 2048 || /[\u0000-\u001f\u007f%]/u.test(path)) return null;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (path.length > 1 && path.endsWith('/')) return null;
  return path;
}

function matchesPath(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.at(-1) === '*') {
    if (pathParts.length < patternParts.length - 1) return false;
  } else if (patternParts.length !== pathParts.length) {
    return false;
  }
  return patternParts.every((part, index) => part.startsWith(':') || part === '*' || part === pathParts[index]);
}

function hasClientOwnershipMetadata(request: Request): boolean {
  if (containsOwnershipField(request.query, 0, true)) return true;
  if (Object.keys(request.headers ?? {}).some(isOwnerHeaderName)) return true;
  return false;
}

export function hasHostedClientOwnershipMetadata(
  request: Request,
  includeBody = false,
): boolean {
  return hasClientOwnershipMetadata(request)
    || (includeBody && containsOwnershipField(request.body));
}

function containsPathOwnershipMetadata(path: string): boolean {
  return path.split('/').some((segment) => {
    // A bare segment is an opaque route identifier. For explicit path
    // parameters, inspect only the name before `=`; values are untrusted but
    // are not field names and must not trigger a false positive.
    return segment.split(/[;,&]/u).some((parameter) => {
      const equals = parameter.indexOf('=');
      if (equals < 0) return false;
      return parameter
        .slice(0, equals)
        .split(/[^a-z0-9_-]+/iu)
        .some((part) => part.length > 0 && isStrictOwnerFieldName(part, true));
    });
  });
}

function containsOwnershipField(value: unknown, depth = 0, includeGeneric = false): boolean {
  if (value == null || typeof value !== 'object') return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth }];
  let inspected = 0;
  let scheduled = 1;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) continue;
    if (++inspected > 10_000 || current.depth > 64) return true;
    if (current.value == null || typeof current.value !== 'object') continue;
    const enqueue = (child: unknown): boolean => {
      if (scheduled >= 10_000) return false;
      scheduled += 1;
      pending.push({ value: child, depth: current.depth + 1 });
      return true;
    };
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        if (!enqueue(current.value[index])) return true;
      }
      continue;
    }
    for (const key in current.value) {
      if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
      if (isOwnerFieldName(key, includeGeneric)) return true;
      if (!enqueue((current.value as Record<string, unknown>)[key])) return true;
    }
  }
  return false;
}

function isOwnerFieldName(key: string, includeGeneric = false): boolean {
  if (isStrictOwnerFieldName(key, includeGeneric)) return true;
  if (!/[.[\]]/u.test(key)) return false;
  return key
    .split(/[^a-z0-9_-]+/iu)
    .some((part) => part.length > 0 && isStrictOwnerFieldName(part, includeGeneric));
}

function isStrictOwnerFieldName(key: string, includeGeneric = false): boolean {
  const normalized = key.replaceAll(/[-_]/gu, '').toLowerCase();
  return OWNER_FIELD_NAMES.has(normalized)
    || (includeGeneric && GENERIC_OWNER_FIELD_NAMES.has(normalized));
}

function isOwnerHeaderName(key: string): boolean {
  const lower = key.toLowerCase();
  const normalized = lower.replaceAll(/[-_]/gu, '');
  return OWNER_HEADER_NAMES.has(lower)
    || OWNER_FIELD_NAMES.has(normalized)
    || GENERIC_OWNER_FIELD_NAMES.has(normalized)
    || /^(?:x|cf|databricks)-(?:account|namespace|owner|storage|tenant|user)(?:-|$)/u.test(lower)
    || /^(?:x-forwarded|x-envoy-external|forwarded)-(?:account|namespace|owner|storage|tenant|user)(?:-|$)/u.test(lower);
}

function isNonEmptySafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && isSafeText(value, maxLength);
}

function isSafeText(value: string, maxLength: number): boolean {
  return value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function reject(
  response: Response,
  status: number,
  code: Extract<ApiErrorCode, `HOSTED_${string}`>,
  message: string,
): void {
  response.status(status).json(createApiErrorResponse({ code, message }));
}
