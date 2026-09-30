import { DATABRICKS_NAMED_REASONS, DatabricksNamesError, parseDatabricksNames, type DatabricksNamedInputResult, type DatabricksNamedScanRequest } from '@readable-studio/contracts';
import { record } from './databricks/named-failure.js';

export function databricksNamedRequest(value: unknown): DatabricksNamedScanRequest {
  const body = record(value);
  if (Object.keys(body).some(key => !['profileId', 'names', 'allowInference', 'checkReasoning', 'kindHint', 'apiHint'].includes(key))
    || typeof body.profileId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.profileId)
    || typeof body.names !== 'string' || body.names.length > 100_000 || body.allowInference !== true
    || body.checkReasoning !== undefined && typeof body.checkReasoning !== 'boolean') throw new DatabricksNamesError('invalid-name');
  parseDatabricksNames(body.names);
  const kind = body.kindHint; const api = body.apiHint;
  if (kind !== undefined && kind !== 'auto' && kind !== 'serving-endpoint' && kind !== 'uc-model-service') throw new DatabricksNamesError('invalid-name');
  if (api !== undefined && api !== 'auto' && api !== 'openai-completions' && api !== 'anthropic-messages') throw new DatabricksNamesError('invalid-name');
  return { profileId: body.profileId, names: body.names, allowInference: true,
    ...(typeof body.checkReasoning === 'boolean' ? { checkReasoning: body.checkReasoning } : {}),
    ...(kind === undefined ? {} : { kindHint: kind }), ...(api === undefined ? {} : { apiHint: api }) };
}
export function publicNamedResult(row: DatabricksNamedInputResult): DatabricksNamedInputResult {
  if (!Number.isSafeInteger(row.inputIndex) || row.inputIndex < 0 || row.inputIndex > 19
    || !['pending', 'verified', 'chat-only', 'already-registered', 'failed', 'inconclusive'].includes(row.state)
    || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 4
    || parseDatabricksNames(row.displayName).length !== 1
    || row.endpointId !== undefined && !/^dbe_[a-f0-9]{32}$/.test(row.endpointId)) throw new Error('Invalid named result');
  if (row.failure && (!DATABRICKS_NAMED_REASONS.includes(row.failure.reason)
    || !['correct-name', 'check-name-or-permissions', 'request-entitlement', 'request-invoke-permission', 'reconnect', 'check-network', 'change-api', 'retry'].includes(row.failure.action)
    || row.failure.upstreamStatus !== null && (!Number.isInteger(row.failure.upstreamStatus) || row.failure.upstreamStatus < 100 || row.failure.upstreamStatus > 599))) throw new Error('Invalid named failure');
  if (row.checks && Object.values(row.checks).some(value => !['passed', 'failed', 'inconclusive', 'not-run'].includes(value))) throw new Error('Invalid named checks');
  return { inputIndex: row.inputIndex, displayName: row.displayName, state: row.state, attempts: row.attempts,
    ...(row.endpointId ? { endpointId: row.endpointId } : {}),
    ...(row.failure ? { failure: { reason: row.failure.reason, action: row.failure.action, upstreamStatus: row.failure.upstreamStatus } } : {}),
    ...(row.checks ? { checks: { streaming: row.checks.streaming, tools: row.checks.tools, effort: row.checks.effort } } : {}) };
}
