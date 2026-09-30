import type { DatabricksNamedFailure, DatabricksNamedReason } from '@readable-studio/contracts';
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
const actions = {
  'name-not-found': 'correct-name', 'not-found-or-hidden': 'check-name-or-permissions', 'not-entitled': 'request-entitlement',
  'not-invocable': 'request-invoke-permission', 'permission-denied': 'request-invoke-permission', 'workspace-unreachable': 'check-network',
  'auth-failed': 'reconnect', 'unsupported-task': 'change-api', 'request-incompatible': 'change-api', 'rate-limited': 'retry',
  'upstream-failed': 'retry', 'incomplete-response': 'retry', cancelled: 'retry',
} as const;
export class NamedProbeError extends Error {
  readonly failure: DatabricksNamedFailure;
  constructor(reason: DatabricksNamedReason, status: number | null = null) {
    super(reason); this.failure = { reason, upstreamStatus: status, action: actions[reason] };
  }
}
/** No upstream free text escapes. Ambiguous 404 is intentionally NOT called a typo. */
export function namedFailure(status: number, payload: unknown, exists: boolean): NamedProbeError {
  const outer = record(payload); const inner = record(outer.error);
  const code = outer.error_code ?? inner.code;
  const message = String(inner.message ?? outer.message ?? '');
  const entitlement = /(?:does not have|missing|requires?|denied|lack).*\bEXECUTE\b|\bnot entitled\b|model.*entitlement/i.test(message);
  const masked = /permission|access|not authorized|hidden/i.test(message);
  const reason = status === 401 ? 'auth-failed'
    : status === 403 && entitlement ? 'not-entitled' : status === 403 ? exists ? 'not-invocable' : 'permission-denied'
    : status === 404 ? code === 'RESOURCE_DOES_NOT_EXIST' && !masked ? 'name-not-found' : 'not-found-or-hidden'
    : status === 429 ? 'rate-limited' : status >= 500 ? 'upstream-failed' : 'request-incompatible';
  return new NamedProbeError(reason, status);
}
