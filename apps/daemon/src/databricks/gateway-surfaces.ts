import type { DatabricksEndpointApi } from '@readable-studio/contracts';

type Json = Record<string, unknown>;
function record(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact recorded identities, not provider-name heuristics. See the VDI matrix. */
export function measuredGatewayApi(name: string): Exclude<DatabricksEndpointApi, null> | undefined {
  switch (name) {
    case 'system.ai.claude-sonnet-5': return 'anthropic-messages';
    case 'system.ai.gpt-oss-120b': return 'openai-completions';
    default: return undefined;
  }
}

export function requestsEffort(body: Json): boolean {
  return typeof body.reasoning_effort === 'string' && !['none', 'off'].includes(body.reasoning_effort)
    || record(body.output_config) && typeof body.output_config.effort === 'string'
    || record(body.thinking) && ['adaptive', 'enabled'].includes(String(body.thinking.type));
}

/** Remove schema keywords, not user property names or literal enum/default data. */
function chatSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(chatSchema);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['strict', 'additionalProperties'].includes(key))
    .map(([key, child]) => {
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key) && record(child)) {
        return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, chatSchema(schema)]))];
      }
      return [key, ['enum', 'const', 'default', 'examples'].includes(key) ? child : chatSchema(child)];
    }));
}

/** Shared by Chat and Responses: the gateway rejects these keys even when false. */
export function gatewayFunctionTool(tool: Json): Json {
  const { strict: _strict, ...fn } = tool;
  return { ...fn, parameters: chatSchema(fn.parameters) };
}

export function gatewayChatRequest(body: Json): Json {
  const { reasoning_effort, parallel_tool_calls: _parallel, ...result } = body;
  // GPT-OSS Chat has measured effort support in some workspaces. Preserve active
  // effort so other gateways reject it honestly rather than silently downgrading.
  if (requestsEffort(body) && reasoning_effort !== undefined) result.reasoning_effort = reasoning_effort;
  if (Array.isArray(body.tools)) result.tools = body.tools.map((tool: unknown) => {
    if (!record(tool) || !record(tool.function)) return tool;
    return { ...tool, function: gatewayFunctionTool(tool.function) };
  });
  return result;
}

export function nativeMessagesRequest(body: Json): Json {
  const { max_completion_tokens, stream_options: _stream, reasoning_effort, parallel_tool_calls: _parallel, ...result } = body;
  if (result.max_tokens === undefined && max_completion_tokens !== undefined) result.max_tokens = max_completion_tokens;
  if (typeof reasoning_effort === 'string' && !['none', 'off'].includes(reasoning_effort)) {
    result.thinking ??= { type: 'adaptive' };
    result.output_config ??= { effort: reasoning_effort };
  }
  return result;
}
