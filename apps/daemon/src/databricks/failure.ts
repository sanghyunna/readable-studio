import type { DatabricksErrorCode, DatabricksFailureDetail, DatabricksFailureReason } from '@readable-studio/contracts';
import { DatabricksServiceError } from './client.js';

const hints: Record<DatabricksFailureReason, string> = {
  auth: 'Authentication was rejected. Sign in again or replace the expired token.',
  'permission-denied': 'Access was denied. Check model permissions.',
  'model-not-found': 'The model was not found. Rescan and register an available endpoint.',
  'bad-request': 'The endpoint rejected the request shape. Check the protocol and supported parameters.',
  'rate-limit': 'The endpoint rate limit was reached. Retry later.',
  'upstream-server': 'The upstream service failed. Retry later.',
  'upstream-rejected': 'The upstream service rejected the request. Check endpoint configuration.',
  transport: 'The gateway could not be reached or the connection was interrupted. Check network access and retry.',
  relay: 'The local relay rejected the request. Restart the run; if it repeats, report a runtime defect.',
  'invalid-response': 'The gateway returned an invalid or interrupted response. Retry; if it repeats, check protocol compatibility.',
  'runtime-unavailable': 'The bundled Pi engine is missing or invalid. Re-extract a complete portable build; this is not a workspace authentication failure.',
  'runtime-storage': 'The local runtime files could not be prepared. Check data-directory permissions and available disk space.',
  configuration: 'The local Databricks configuration is unavailable or incompatible. Check setup and registered models.',
};

export function failureDetail(reason: DatabricksFailureReason, upstreamStatus: number | null = null, upstreamMessage?: string): DatabricksFailureDetail {
  return {
    reason, upstreamStatus,
    message: `Databricks [${reason}; ${upstreamStatus === null ? 'no upstream response' : `HTTP ${upstreamStatus}`}]: ${hints[reason]}${upstreamMessage ? ` ${upstreamMessage}` : ''}`,
    retryable: ['rate-limit', 'upstream-server', 'transport', 'invalid-response'].includes(reason),
    ...(upstreamMessage ? { upstreamMessage } : {}),
  };
}

/** Carries only closed, daemon-owned diagnostic fields; never retains an exception/cause. */
export class DatabricksRuntimeError extends DatabricksServiceError {
  readonly detail: DatabricksFailureDetail;
  constructor(reason: DatabricksFailureReason) {
    const detail = failureDetail(reason);
    super('DATABRICKS_UPSTREAM_UNAVAILABLE', detail.retryable);
    this.detail = detail;
  }
}

export function serviceFailureDetail(code: DatabricksErrorCode): DatabricksFailureDetail {
  const reason = code === 'DATABRICKS_AUTH_REQUIRED' ? 'auth'
    : code === 'DATABRICKS_PERMISSION_DENIED' ? 'permission-denied'
    : code === 'DATABRICKS_SCAN_EXPIRED' ? 'model-not-found'
    : code === 'DATABRICKS_RATE_LIMITED' ? 'rate-limit'
    : code === 'DATABRICKS_UPSTREAM_UNAVAILABLE' ? 'transport' : 'configuration';
  const detail = failureDetail(reason);
  // Codes/actions remain useful for setup failures that are not inference requests.
  if (reason === 'configuration') detail.message += ` (${code})`;
  return detail;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Positive recognition, not a denylist of token formats. Arbitrary free text, URLs,
// encoded credentials and metadata never cross the boundary. Exact known messages
// can be retained even when the enclosing gateway body includes private selectors.
const safeMessages = new Set([
  'Token expired', 'Invalid access token',
  '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
  "output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'",
  'max_tokens: Field required',
]);

export function upstreamFailure(status: number, payload: unknown, privateValues: readonly string[]): DatabricksFailureDetail {
  const errorType = record(payload) && record(payload.error) ? payload.error.type : undefined;
  const streamReason: DatabricksFailureReason = errorType === 'authentication_error' ? 'auth'
    : errorType === 'permission_error' ? 'permission-denied' : errorType === 'not_found_error' ? 'model-not-found'
    : errorType === 'invalid_request_error' ? 'bad-request' : errorType === 'rate_limit_error' ? 'rate-limit'
    : ['api_error', 'overloaded_error'].includes(String(errorType)) ? 'upstream-server' : 'upstream-rejected';
  const reason: DatabricksFailureReason = status === 401 ? 'auth' : status === 403 ? 'permission-denied'
    : status === 404 ? 'model-not-found' : [400, 413, 422].includes(status) ? 'bad-request'
    : status === 429 ? 'rate-limit' : status >= 500 ? 'upstream-server' : streamReason;
  const candidates: unknown[] = [];
  if (record(payload)) {
    candidates.push(payload.message, record(payload.error) ? payload.error.message : undefined);
    if (Array.isArray(payload.details)) for (const detail of payload.details) {
      if (!record(detail) || !record(detail.metadata) || typeof detail.metadata.upstream_body !== 'string') continue;
      try {
        const body: unknown = JSON.parse(detail.metadata.upstream_body);
        if (record(body) && record(body.error)) candidates.push(body.error.message);
      } catch { /* Malformed upstream diagnostics are deliberately not forwarded. */ }
    }
  }
  const message = candidates.find((value): value is string => typeof value === 'string' && safeMessages.has(value)
    && !privateValues.some((secret) => secret && value.includes(secret)));
  return failureDetail(reason, status, message);
}

/** Bound error-body consumption independently of the inference body/stream limit. */
export async function readUpstreamError(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) return undefined;
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { return undefined; } // Non-JSON errors still retain the HTTP reason/status.
  } catch { return undefined; } // A broken error body must not erase its received HTTP status.
  finally {
    try { await reader.cancel(); }
    catch { /* The received HTTP failure remains authoritative if cancellation fails. */ }
    reader.releaseLock();
  }
}
