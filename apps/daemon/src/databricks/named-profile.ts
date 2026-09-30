import type { DatabricksEndpointApi, DatabricksEndpointKind } from '@readable-studio/contracts';
import { gatewayChatRequest, gatewayFunctionTool, nativeMessagesRequest } from './gateway-surfaces.js';

/** Accepted transport evidence, distinct from maximum token/capability claims. */
export interface DatabricksNamedProfile {
  readonly version: 1;
  readonly api: Exclude<DatabricksEndpointApi, null>;
  readonly kind: DatabricksEndpointKind;
  readonly tokenField: 'max_tokens' | 'max_completion_tokens';
  readonly testedBudget: number;
  /** Authoritative metadata/table or a recognized upstream numeric ceiling, never the tested budget. */
  readonly outputLimit?: number;
  readonly tools: 'enabled' | 'disabled';
  readonly reasoning: readonly string[];
  readonly checkedAt: string;
}
export function namedPath(profile: Pick<DatabricksNamedProfile, 'kind' | 'api'>, name: string): string {
  return profile.api === 'anthropic-messages' ? '/ai-gateway/anthropic/v1/messages'
    : profile.kind === 'serving-endpoint' ? `/serving-endpoints/${encodeURIComponent(name)}/invocations` : '/ai-gateway/openai/v1/chat/completions';
}

/** Used by preflight AND the real relay: no untested route or optional fields. */
export function namedRequest(profile: DatabricksNamedProfile, name: string, body: Record<string, unknown>): Record<string, unknown> {
  const wire = profile.api === 'anthropic-messages' ? nativeMessagesRequest(body) : gatewayChatRequest(body);
  const budget = wire.max_tokens ?? wire.max_completion_tokens;
  delete wire.max_tokens; delete wire.max_completion_tokens;
  wire[profile.tokenField] = Math.min(typeof budget === 'number' && budget > 0 ? budget : profile.testedBudget, profile.outputLimit ?? profile.testedBudget);
  delete wire.store; delete wire.stream_options; delete wire.parallel_tool_calls;
  if (profile.kind === 'serving-endpoint' && profile.api === 'openai-completions') delete wire.model;
  else wire.model = name;
  if (profile.tools === 'disabled') { delete wire.tools; delete wire.tool_choice; }
  else if (Array.isArray(wire.tools)) wire.tools = wire.tools.map(tool => typeof tool === 'object' && tool !== null ? gatewayFunctionTool(Object.fromEntries(Object.entries(tool))) : tool);
  if (!profile.reasoning.length) { delete wire.reasoning_effort; delete wire.thinking; delete wire.output_config; }
  return wire;
}
