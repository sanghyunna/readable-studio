import type { DatabricksNamedScanRequest, DatabricksVerificationResponse } from '@readable-studio/contracts';
import { classifyProtocol } from './catalogue.js';
import { DatabricksServiceError, withDeadline } from './client.js';
import type { DiscoveredResource, WorkspaceScanOptions } from './scan.js';
import { servingTask } from './serving-task.js';
import { readUpstreamError } from './failure.js';
import { rejectsTools } from './tool-free.js';
import { namedFailure, NamedProbeError, record } from './named-failure.js';
import { namedPath, namedRequest, type DatabricksNamedProfile } from './named-profile.js';
import { readNamedStream } from './named-stream.js';
import { outputCeiling } from './request-limits.js';

export interface NamedProbeResult {
  readonly resource: DiscoveredResource;
  readonly profile: DatabricksNamedProfile;
  readonly tools: boolean;
  readonly attempts: number;
  readonly checks: DatabricksVerificationResponse['checks'];
}
export interface NamedProbeInput {
  readonly name: string;
  readonly request: DatabricksNamedScanRequest;
  readonly workspace: WorkspaceScanOptions;
  readonly onAttempt: () => void;
}

export async function probeNamed(input: NamedProbeInput): Promise<NamedProbeResult> {
  const { name, request, workspace } = input;
  try {
    return await withDeadline(async signal => {
      const kind = request.kindHint && request.kindHint !== 'auto' ? request.kindHint : name.split('.').length >= 3 ? 'uc-model-service' : 'serving-endpoint';
      const path = kind === 'serving-endpoint' ? '/api/2.0/serving-endpoints/' : '/api/2.1/unity-catalog/model-services/';
      let exists = false;
      let metadata: Record<string, unknown> = {};
      await withDeadline(async bounded => {
        const response = await workspace.fetch(new URL(`${path}${encodeURIComponent(name)}`, workspace.binding.host).toString(), {
          headers: { Authorization: `Bearer ${workspace.bearer}` }, signal: bounded, redirect: 'error',
        });
        if (response.ok) { exists = true; metadata = record(await response.json()); }
        else if (response.status !== 403 && response.status !== 404) throw namedFailure(response.status, await readUpstreamError(response), false);
        else await response.body?.cancel();
      }, 10_000, signal);
      const task = servingTask(metadata);
      if (task === 'llm/v1/embeddings' || task === 'llm/v1/completions') throw new NamedProbeError('unsupported-task');
      const resource: DiscoveredResource = { kind, name, metadata };
      const api = request.apiHint && request.apiHint !== 'auto' ? request.apiHint : classifyProtocol(resource) ?? 'openai-completions';
      let profile: DatabricksNamedProfile = { version: 1, kind, api, tokenField: kind === 'serving-endpoint' || api === 'anthropic-messages' ? 'max_tokens' : 'max_completion_tokens',
        testedBudget: 256, tools: 'enabled', reasoning: [], checkedAt: new Date().toISOString() };
      let attempts = 0;
      const checks: DatabricksVerificationResponse['checks'] = { streaming: 'not-run', tools: 'not-run', effort: 'not-run' };
      const invoke = async (reasoning = false) => withDeadline(async bounded => {
        attempts++; input.onAttempt();
        const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
        const tools = !reasoning && profile.tools === 'enabled';
        const anthropic = profile.api === 'anthropic-messages';
        const body: Record<string, unknown> = { messages: [{ role: 'user', content: tools ? 'Call readable_probe with ok=true. Do not perform any other action.' : 'Reply with OK.' }], stream: true,
          ...(tools ? { tools: anthropic ? [{ name: 'readable_probe', description: 'Return the connectivity check result; this tool is never executed.', input_schema: schema }]
            : [{ type: 'function', function: { name: 'readable_probe', description: 'Return the connectivity check result; this tool is never executed.', parameters: schema } }], tool_choice: anthropic ? { type: 'auto' } : 'auto' } : {}),
          ...(reasoning ? anthropic ? { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } : { reasoning_effort: 'low' } : {}),
        };
        const response = await workspace.fetch(new URL(namedPath(profile, name), workspace.binding.host).toString(), { method: 'POST', redirect: 'error', signal: bounded,
          headers: { Authorization: `Bearer ${workspace.bearer}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}) },
          body: JSON.stringify(namedRequest(reasoning ? { ...profile, reasoning: ['low'] } : profile, name, body)),
        });
        if (!response.ok) return { accepted: false as const, status: response.status, payload: await readUpstreamError(response) };
        return { accepted: true as const, ...await readNamedStream(response, bounded) };
      }, 15_000, signal);
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await invoke();
        if (result.accepted) {
          checks.streaming = 'passed'; checks.tools = result.tools ? 'passed' : 'inconclusive';
          profile = { ...profile, tools: result.tools ? 'enabled' : 'disabled' };
          if (request.checkReasoning) {
            try {
              const effort = await invoke(true);
              checks.effort = effort.accepted ? 'passed' : 'failed';
              if (effort.accepted) profile = { ...profile, reasoning: ['low'] };
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              checks.effort = 'inconclusive';
            }
          }
          return { resource: { ...resource, measuredApi: profile.api }, profile, tools: result.tools, attempts, checks };
        }
        const payload = record(result.payload); const detail = record(payload.error);
        const message = String(detail.message ?? payload.message ?? '');
        if (result.status === 400 && attempt < 2) {
          if (profile.tools === 'enabled' && rejectsTools(message)) { profile = { ...profile, tools: 'disabled' }; continue; }
          const unknown = /(?:unknown field|unrecognized (?:request )?(?:argument|field)|unsupported parameter)\s*:?\s*["']?(max_completion_tokens|max_tokens)["']?/i.exec(message)?.[1];
          if (unknown === profile.tokenField && profile.api === 'openai-completions') { profile = { ...profile, tokenField: profile.tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens' }; continue; }
          const ceiling = outputCeiling(message);
          if (ceiling !== undefined && ceiling < profile.testedBudget) { profile = { ...profile, testedBudget: ceiling, outputLimit: ceiling }; continue; }
          if (kind === 'uc-model-service' && profile.api === 'openai-completions' && /(?:use|requires?)\s+(?:the\s+)?(?:anthropic\/v1\/messages|Messages API)/i.test(message)) {
            profile = { ...profile, api: 'anthropic-messages', tokenField: 'max_tokens' }; continue;
          }
        }
        throw namedFailure(result.status, result.payload, exists);
      }
      throw new NamedProbeError('request-incompatible');
    }, 45_000, workspace.signal);
  } catch (error) {
    if (error instanceof NamedProbeError) throw error;
    if (error instanceof Error || error instanceof DatabricksServiceError) throw new NamedProbeError(workspace.signal?.aborted ? 'cancelled' : 'workspace-unreachable');
    throw error;
  }
}
