type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid protocol object');
  return value as Json;
}
function blocks(content: unknown): Json[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw new Error('Invalid message content');
  return content.map(raw => {
    const part = object(raw);
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url = object(part.image_url).url;
      if (typeof url !== 'string') throw new Error('Invalid image');
      const data = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(url);
      return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } };
    }
    throw new Error('Unsupported message content');
  });
}

/** The first recovery turn still has a Chat-configured Pi child. Translate its
 * complete request, not just the tools field, and keep the child dialect stable.
 */
export function messagesRequest(body: Json): Json {
  if (!Array.isArray(body.messages)) throw new Error('Invalid chat request');
  const system: Json[] = [];
  const messages: Array<{ role: string; content: Json[] }> = [];
  for (const raw of body.messages) {
    const message = object(raw);
    if (message.role === 'system' || message.role === 'developer') { system.push(...blocks(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : blocks(message.content) }]
      : blocks(message.content);
    if (Array.isArray(message.tool_calls)) for (const rawCall of message.tool_calls) {
      const call = object(rawCall); const fn = object(call.function);
      if (typeof fn.arguments !== 'string') throw new Error('Invalid tool arguments');
      content.push({ type: 'tool_use', id: call.id, name: fn.name, input: JSON.parse(fn.arguments) });
    }
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content });
  }
  const result: Json = { model: body.model, messages, ...(system.length ? { system } : {}) };
  for (const field of ['stream', 'temperature', 'top_p']) if (body[field] !== undefined) result[field] = body[field];
  if (body.max_completion_tokens !== undefined || body.max_tokens !== undefined) result.max_tokens = body.max_completion_tokens ?? body.max_tokens;
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Array.isArray(body.tools) && body.tool_choice !== 'none') result.tools = body.tools.map(raw => {
    const tool = object(raw); const fn = object(tool.function);
    if (tool.type !== 'function') throw new Error('Unsupported tool');
    return { name: fn.name, ...(fn.description === undefined ? {} : { description: fn.description }), input_schema: fn.parameters };
  });
  if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
  else if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
  else if (body.tool_choice && typeof body.tool_choice === 'object') {
    result.tool_choice = { type: 'tool', name: object(object(body.tool_choice).function).name };
  }
  if (body.parallel_tool_calls === false && result.tools) {
    result.tool_choice = { ...(result.tool_choice ? object(result.tool_choice) : { type: 'auto' }), disable_parallel_tool_use: true };
  }
  if (typeof body.reasoning_effort === 'string' && !['none', 'off'].includes(body.reasoning_effort)) {
    result.thinking = { type: 'adaptive' };
    result.output_config = { effort: body.reasoning_effort };
  }
  return result;
}

function finishReason(reason: unknown): string {
  return reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' ? 'length' : 'stop';
}
function usage(value: Json): Json {
  const cached = Number(value.cache_read_input_tokens ?? 0);
  const input = Number(value.input_tokens ?? 0) + cached + Number(value.cache_creation_input_tokens ?? 0);
  const output = Number(value.output_tokens ?? 0);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
}

export function messagesResponse(payload: Json): Json {
  if (payload.type !== 'message' || !Array.isArray(payload.content)) throw new Error('Invalid Messages response');
  const text: string[] = []; const reasoning: string[] = []; const calls: Json[] = [];
  for (const raw of payload.content) {
    const block = object(raw);
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning.push(block.thinking);
    else if (block.type === 'tool_use') calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
    else if (block.type !== 'redacted_thinking') throw new Error('Unsupported Messages content');
  }
  return { id: payload.id, model: payload.model, object: 'chat.completion', created: 0,
    choices: [{ index: 0, message: { role: 'assistant', content: text.join('') || null,
      ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
    finish_reason: finishReason(payload.stop_reason) }], usage: usage(payload.usage ? object(payload.usage) : {}) };
}

/** Incremental native/compact Messages -> Chat SSE conversion. Preserve call IDs,
 * arguments, thinking and usage. Never turn a truncated stream into a completion.
 */
export class MessagesChatStream {
  completed = false;
  private id: unknown;
  private model: unknown;
  private compact = false;
  private stop: unknown;
  private tokens: Json = {};
  private readonly tools = new Map<unknown, number>();
  private chunk(delta: Json, finish_reason: string | null = null, tokens?: Json): Json {
    return { id: this.id, model: this.model, object: 'chat.completion.chunk', created: 0,
      choices: [{ index: 0, delta, finish_reason }], ...(tokens ? { usage: usage(tokens) } : {}) };
  }
  push(value: Json | '[DONE]'): Array<Json | '[DONE]'> {
    if (value === '[DONE]') {
      if (!this.compact) { if (!this.completed) throw new Error('Incomplete Messages stream'); return []; }
      this.completed = true;
      return [this.chunk({}, 'stop', this.tokens), '[DONE]'];
    }
    if (value.type === 'message_start' || value.type === 'start') {
      const message = object(value.message); this.id = message.id; this.model = message.model;
      this.compact = value.type === 'start'; this.tokens = message.usage ? object(message.usage) : {};
      return [this.chunk({ role: 'assistant', content: '' })];
    }
    if (this.compact && value.type === 'text_delta') return [this.chunk({ content: object(value.delta).text })];
    if (value.type === 'content_block_start') {
      const block = object(value.content_block);
      if (block.type === 'tool_use') {
        const index = this.tools.size; this.tools.set(value.index, index);
        const input = object(block.input);
        return [this.chunk({ tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: Object.keys(input).length ? JSON.stringify(input) : '' } }] })];
      }
      if (block.type === 'text' && block.text) return [this.chunk({ content: block.text })];
      if (block.type === 'thinking' && block.thinking) return [this.chunk({ reasoning_content: block.thinking })];
    }
    if (value.type === 'content_block_delta') {
      const delta = object(value.delta);
      if (delta.type === 'text_delta') return [this.chunk({ content: delta.text })];
      if (delta.type === 'thinking_delta') return [this.chunk({ reasoning_content: delta.thinking })];
      if (delta.type === 'input_json_delta') {
        const index = this.tools.get(value.index);
        if (index === undefined) throw new Error('Missing Messages tool call');
        return [this.chunk({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] })];
      }
    }
    if (value.type === 'message_delta') {
      this.stop = object(value.delta).stop_reason;
      this.tokens = { ...this.tokens, ...(value.usage ? object(value.usage) : {}) };
    }
    if (value.type === 'message_stop') {
      this.completed = true; return [this.chunk({}, finishReason(this.stop), this.tokens), '[DONE]'];
    }
    return [];
  }
}
