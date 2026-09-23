import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabricksRuntimeResolution } from './service.js';
import type { DatabricksWireCapabilities } from './catalogue.js';
import type { DatabricksFailureDetail } from '@readable-studio/contracts';
import { failureDetail, readUpstreamError, upstreamFailure } from './failure.js';
import { listenOnFetchCompatiblePort } from '../fetch-compatible-listener.js';
import { artifactDeliveryRequest, rejectsTools } from './tool-free.js';
import { messagesRequest, messagesResponse, MessagesChatStream } from './messages.js';
import { gatewayChatRequest, gatewayFunctionTool, measuredGatewayApi, nativeMessagesRequest, requestsEffort } from './gateway-surfaces.js';
import { capturedFailureDetail, createDatabricksFailureCapture, type DatabricksRouteKind } from './failure-capture.js';

export interface DatabricksRelay {
  /** Child-visible connection material; neither value grants general proxy access. */
  baseUrl: string;
  capabilityKey: string;
  modelAlias: string;
  close(): Promise<void>;
}

export interface DatabricksRelayOptions {
  runtime: DatabricksRuntimeResolution;
  fetch?: typeof fetch;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const OUTPUT_FIELDS = ['max_completion_tokens', 'max_tokens', 'max_output_tokens', 'max_new_tokens'] as const;

/** Recognize validation grammar, not arbitrary numbers in upstream prose. */
function outputCeiling(message: string): number | undefined {
  const field = '(?:max_new_tokens|max_output_tokens|max_completion_tokens|max_tokens)';
  const patterns = [
    new RegExp(`\\b${field}\\s+\\d+\\s+cannot be greater than\\s+${field}\\s+(\\d+)`, 'i'),
    new RegExp(`\\b${field}\\s*:?\\s*(?:\\d+\\s*)?(?:must be|must be less than|cannot be|should be)?\\s*(?:less than or equal to|at most|<=)\\s*(\\d+)`, 'i'),
    new RegExp(`\\b${field}\\s*:\\s*\\d+\\s*>\\s*(\\d+)(?:\\s*[,.;]|\\s*$)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const limit = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(limit) && limit > 0) return limit;
  }
  return undefined;
}
const relayError = (detail: DatabricksFailureDetail) => ({ type: 'error', error: { type: 'api_error', ...detail } });
class UpstreamStreamError extends Error {
  constructor(readonly detail: DatabricksFailureDetail, readonly payload: unknown, readonly toolsRejected = false) { super(detail.message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Translate the managed Pi Chat dialect without changing its selected effort. */
function responsesRequest(body: Record<string, unknown>): Record<string, unknown> {
  const { messages, tools, reasoning_effort, max_completion_tokens, max_tokens, stream_options: _streamOptions,
    tool_choice, ...rest } = body;
  if (!Array.isArray(messages) || (tools !== undefined && !Array.isArray(tools))) throw new Error('Invalid chat request');
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!record(message)) throw new Error('Invalid message');
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.content != null) {
      const content = Array.isArray(message.content) ? message.content.map((part: unknown) => {
        if (!record(part)) throw new Error('Invalid content');
        if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
        if (part.type === 'image_url' && record(part.image_url)) return { type: 'input_image', image_url: part.image_url.url,
          ...(part.image_url.detail === undefined ? {} : { detail: part.image_url.detail }) };
        throw new Error('Unsupported chat content');
      }) : message.content;
      input.push({ role: message.role, content });
    }
    if (Array.isArray(message.tool_calls)) for (const tool of message.tool_calls) {
      if (!record(tool) || !record(tool.function)) throw new Error('Invalid tool call');
      input.push({ type: 'function_call', call_id: tool.id, name: tool.function.name, arguments: tool.function.arguments });
    }
  }
  return {
    ...rest, store: false, input,
    ...(Array.isArray(tools) ? { tools: tools.map((tool: unknown) => {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function)) throw new Error('Unsupported tool');
      return { type: 'function', ...gatewayFunctionTool(tool.function) };
    }) } : {}),
    ...(reasoning_effort === undefined ? {} : { reasoning: { effort: reasoning_effort } }),
    ...(max_completion_tokens === undefined && max_tokens === undefined ? {} : { max_output_tokens: max_completion_tokens ?? max_tokens }),
    ...(tool_choice === undefined ? {} : { tool_choice: record(tool_choice) && record(tool_choice.function)
      ? { type: 'function', name: tool_choice.function.name } : tool_choice }),
  };
}

function chatUsage(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  return { prompt_tokens: value.input_tokens, completion_tokens: value.output_tokens, total_tokens: value.total_tokens,
    prompt_tokens_details: value.input_tokens_details, completion_tokens_details: value.output_tokens_details };
}

function chatResponse(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.output) || !['completed', 'incomplete'].includes(String(payload.status))) throw new Error('Invalid Responses result');
  const content: string[] = [];
  const calls: Record<string, unknown>[] = [];
  for (const item of payload.output) {
    if (!record(item)) throw new Error('Invalid output item');
    if (item.type === 'function_call') calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    if (item.type === 'message' && Array.isArray(item.content)) for (const part of item.content) {
      if (record(part) && typeof part.text === 'string') content.push(part.text);
      else if (record(part) && typeof part.refusal === 'string') content.push(part.refusal);
    }
  }
  return { id: payload.id, object: 'chat.completion', created: payload.created_at, model: payload.model,
    choices: [{ index: 0, message: { role: 'assistant', content: content.join('') || null, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: payload.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop' }], usage: chatUsage(payload.usage) };
}

/** MLflow Chat uses typed content blocks even in streaming deltas. Pi's
 * OpenAI consumer expects strings; preserve visible text and reasoning separately. */
function normalizeChatContent(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.choices)) return payload;
  return { ...payload, choices: payload.choices.map((choice: unknown) => {
    if (!record(choice)) return choice;
    const key = record(choice.delta) ? 'delta' : 'message';
    const message = choice[key];
    if (!record(message) || !Array.isArray(message.content)) return choice;
    const text: string[] = [];
    const reasoning: string[] = [];
    for (const part of message.content) {
      if (!record(part)) throw new Error('Invalid chat content block');
      if (part.type === 'text' && typeof part.text === 'string') text.push(part.text);
      else if (part.type === 'reasoning' && Array.isArray(part.summary)) {
        for (const summary of part.summary) {
          if (!record(summary) || summary.type !== 'summary_text' || typeof summary.text !== 'string') throw new Error('Invalid reasoning summary');
          reasoning.push(summary.text);
        }
      } else throw new Error('Unsupported chat content block');
    }
    return { ...choice, [key]: { ...message, content: text.join(''),
      ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}) } };
  }) };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!record(body)) throw new Error('Invalid request');
  return body;
}

function sendError(response: ServerResponse, status: number, detail = failureDetail('relay')): void {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.end(`event: error\ndata: ${JSON.stringify(relayError(detail))}\n\n`);
  } else {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(relayError(detail)));
  }
}

/** No upstream headers, raw exceptions, error bodies, or resource selectors cross this boundary. */
export async function createDatabricksRelay(options: DatabricksRelayOptions): Promise<DatabricksRelay> {
  const { runtime } = options;
  const upstreamFetch = options.fetch ?? fetch;
  const capabilityKey = `dbr_${randomBytes(32).toString('base64url')}`;
  const expectedKey = Buffer.from(capabilityKey);
  const modelAlias = runtime.appModelId;
  const anthropic = runtime.api === 'anthropic-messages';
  const localPath = anthropic ? '/v1/messages' : '/chat/completions';
  const invocation = /^\/serving-endpoints\/[^/]+\/invocations$/.test(new URL(runtime.baseUrl).pathname);
  const upstream = new URL(`${runtime.baseUrl}${invocation ? '' : localPath}`);
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('Invalid Databricks gateway URL');
  }
  const privateValues = [runtime.apiKey, runtime.model, upstream.origin, upstream.hostname].filter(Boolean);
  const cleanString = (value: string): string => privateValues.reduce(
    (text, secret) => text.split(secret).join(secret === runtime.model ? modelAlias : '[redacted]'), value,
  );
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return cleanString(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (!record(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [cleanString(key), key === 'model' ? modelAlias : sanitize(child)]));
  };
  // Endpoint-local wire capabilities learned from authoritative pre-inference
  // rejections. Never infer OpenAI passthrough support from MLflow API metadata.
  // Persisted beside registration; fresh metadata invalidates the learned recipe.
  let responsesUnsupported = runtime.wireCapabilities?.responsesUnsupported ?? false;
  // Metadata advertises dialects, not URLs. Discover acceptance among documented
  // same-origin surfaces; never follow upstream URLs or guess from model identity.
  // Serving invocations accept Chat (including function tools), not Responses.
  const responsesPaths = invocation ? [] : [...new Set([`${upstream.pathname.replace(/\/chat\/completions$/, '')}/responses`,
    '/ai-gateway/openai/v1/responses', '/ai-gateway/codex/v1/responses'])];
  let responsesPath = responsesPaths.includes(runtime.wireCapabilities?.responsesPath ?? '')
    ? runtime.wireCapabilities!.responsesPath! : responsesPaths[0]!;
  const messagesPath = '/ai-gateway/anthropic/v1/messages';
  let learnedMessages = runtime.wireCapabilities?.api === 'anthropic-messages';
  // Old artifact recipes did not test Messages; renegotiate them.
  let toolsState: 'supported' | 'unsupported' | 'unknown' = runtime.wireCapabilities?.tools === 'unsupported'
    ? runtime.wireCapabilities.toolSurfaceVersion === 2 ? 'unsupported' : 'unknown'
    : runtime.wireCapabilities?.tools ?? (runtime.capabilities.tools === 'supported' ? 'supported' : 'unknown');
  let chatTokensField = runtime.wireCapabilities?.chatTokensField ?? 'max_completion_tokens';
  let outputLimit = runtime.wireCapabilities?.outputLimit;
  let requiredOutputBudget = runtime.wireCapabilities?.requiredOutputBudget ?? false;
  const omittedFields = new Set<string>(runtime.wireCapabilities?.omittedFields);
  const active = new Set<AbortController>();
  const requests = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const learnedCapabilities = (responses = false, messagesSurface = learnedMessages): DatabricksWireCapabilities => ({
    responsesUnsupported, ...(responses ? { responsesPath } : {}),
    ...(messagesSurface ? { api: 'anthropic-messages' as const } : {}),
    tools: toolsState, toolSurfaceVersion: 2,
    ...(toolsState === 'supported' ? { toolsCompletionVersion: 1 as const } : {}),
    chatTokensField, ...(outputLimit === undefined ? {} : { outputLimit }), requiredOutputBudget,
    omittedFields: [...omittedFields],
  });
  const invalidateTools = async () => {
    toolsState = 'unknown';
    await runtime.onCapabilitiesLearned?.(learnedCapabilities());
  };
  const streamError = (status: number, payload: unknown) => {
    const message = record(payload) ? payload.message ?? (record(payload.error) ? payload.error.message : undefined) : undefined;
    return new UpstreamStreamError(upstreamFailure(status, payload, privateValues), payload, typeof message === 'string' && rejectsTools(message));
  };

  async function forwardStream(upstreamResponse: Response, response: ServerResponse, signal: AbortSignal, responses = false, translatedMessages = false): Promise<void> {
    if (!upstreamResponse.body) throw new Error('Missing stream');
    signal.throwIfAborted();
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    response.flushHeaders();
    const reader = upstreamResponse.body.getReader();
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= reader.cancel();
      // Observe immediately; the finally block below awaits and propagates failure.
      void cancellation.catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    let index = 0;
    let compactAnthropic = false;
    let responseId: unknown;
    let created: unknown;
    let completed = false;
    const toolIndexes = new Map<unknown, number>();
    const messagesStream = translatedMessages ? new MessagesChatStream() : undefined;
    async function emit(value: unknown, event?: string): Promise<void> {
      signal.throwIfAborted();
      const data = value === '[DONE]' ? value : JSON.stringify(sanitize(value));
      if (!response.write(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`)) {
        await once(response, 'drain', { signal });
      }
    }
    async function frame(raw: string): Promise<void> {
      const lines = raw.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) return; // Comments and upstream ids are deliberately not forwarded.
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      if (event === 'error') throw streamError(upstreamResponse.status, JSON.parse(data));
      if (data === '[DONE]') {
        if (!responses) completed = true;
        if (messagesStream) {
          for (const chunk of messagesStream.push('[DONE]')) await emit(chunk);
          return;
        }
        if (anthropic && compactAnthropic) {
          await emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }, 'message_delta');
          await emit({ type: 'message_stop' }, 'message_stop');
        } else await emit(data);
        return;
      }
      const payload: unknown = JSON.parse(data);
      if (!record(payload)) throw new Error('Invalid upstream frame');
      if (payload.type === 'error' || payload.error) throw streamError(upstreamResponse.status, payload);
      if (payload.type === 'message_stop' || Array.isArray(payload.choices)
        && payload.choices.some(choice => record(choice) && typeof choice.finish_reason === 'string')) completed = true;
      if (messagesStream) {
        for (const chunk of messagesStream.push(payload)) await emit(chunk);
        return;
      }
      if (responses) {
        const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, usage?: unknown) => emit({
          id: responseId, object: 'chat.completion.chunk', created, model: modelAlias,
          choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
        });
        if (payload.type === 'response.created' && record(payload.response)) {
          responseId = payload.response.id;
          created = payload.response.created_at;
          await chunk({ role: 'assistant', content: '' });
        } else if (payload.type === 'response.output_text.delta' || payload.type === 'response.refusal.delta') {
          await chunk({ content: payload.delta });
        } else if (payload.type === 'response.reasoning_summary_text.delta') {
          await chunk({ reasoning_content: payload.delta });
        } else if (payload.type === 'response.output_item.added' && record(payload.item) && payload.item.type === 'function_call') {
          const toolIndex = toolIndexes.size;
          toolIndexes.set(payload.output_index, toolIndex);
          await chunk({ tool_calls: [{ index: toolIndex, id: payload.item.call_id, type: 'function',
            function: { name: payload.item.name, arguments: payload.item.arguments ?? '' } }] });
        } else if (payload.type === 'response.function_call_arguments.delta') {
          const toolIndex = toolIndexes.get(payload.output_index);
          if (toolIndex === undefined) throw new Error('Missing tool call');
          await chunk({ tool_calls: [{ index: toolIndex, function: { arguments: payload.delta } }] });
        } else if (payload.type === 'response.completed' || payload.type === 'response.incomplete') {
          if (!record(payload.response)) throw new Error('Missing response');
          const result = chatResponse(payload.response);
          const choices = result.choices as Array<{ finish_reason: string }>;
          await chunk({}, choices[0]!.finish_reason, result.usage);
          await emit('[DONE]');
          completed = true;
        } else if (payload.type === 'response.failed') {
          throw streamError(upstreamResponse.status, payload.response);
        }
        return;
      }
      // The certified gateway compact text stream is not native Anthropic SSE.
      // Normalize only that dialect; native tool/thinking frames pass through intact.
      if (anthropic && payload.type === 'start') {
        compactAnthropic = true;
        const message = record(payload.message) ? payload.message : {};
        await emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }, 'message_start');
      } else if (anthropic && compactAnthropic && payload.type === 'text_start') {
        index = typeof payload.index === 'number' ? payload.index : index;
        await emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, 'content_block_start');
      } else if (anthropic && compactAnthropic && payload.type === 'text_delta') {
        await emit({ type: 'content_block_delta', index, delta: payload.delta }, 'content_block_delta');
      } else if (anthropic && compactAnthropic && payload.type === 'text_end') {
        await emit({ type: 'content_block_stop', index }, 'content_block_stop');
      } else {
        const safeEvent = anthropic && typeof payload.type === 'string' && /^[a-z_]+$/.test(payload.type) ? payload.type
          : event && /^[a-z_]+$/.test(event) ? event : undefined;
        await emit(anthropic ? payload : normalizeChatContent(payload), safeEvent);
      }
    }
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          if (boundary.index > MAX_FRAME_BYTES) throw new Error('Stream frame too large');
          await frame(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
        if (buffer.length > MAX_FRAME_BYTES) throw new Error('Stream frame too large');
        if (done) break;
      }
      if (buffer.trim()) await frame(buffer);
      if (!completed && !messagesStream?.completed) throw new Error('Incomplete upstream stream');
      if (messagesStream && !messagesStream.completed) throw new Error('Incomplete Messages stream');
    } finally {
      signal.removeEventListener('abort', cancel);
      try { await (cancellation ?? reader.cancel()); }
      finally { reader.releaseLock(); }
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const provided = request.headers.authorization?.replace(/^Bearer /, '') ?? request.headers['x-api-key'];
    const key = typeof provided === 'string' ? Buffer.from(provided) : Buffer.alloc(0);
    if (closed || request.method !== 'POST' || request.url !== localPath || request.headers.origin
      || key.length !== expectedKey.length || !timingSafeEqual(key, expectedKey)) {
      sendError(response, 403);
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    response.once('close', abort);
    request.once('aborted', abort);
    const timeout = setTimeout(abort, 10 * 60_000);
    timeout.unref();
    let upstreamStatus: number | null = null;
    let lastAttempt: { routeKind: DatabricksRouteKind; endpoint: URL; body: Record<string, unknown> } | undefined;
    let captureRecorded = false;
    const captureAttempt = async (original: DatabricksFailureDetail, upstreamBody: unknown): Promise<DatabricksFailureDetail> => {
      if (captureRecorded || !lastAttempt || controller.signal.aborted) return original;
      const capture = createDatabricksFailureCapture({ ...lastAttempt, model: runtime.model,
        appModelId: runtime.appModelId, endpointId: runtime.endpointId, status: original.upstreamStatus, upstreamBody,
        privateValues: [runtime.apiKey, runtime.model, encodeURIComponent(runtime.model), lastAttempt.endpoint.href,
          lastAttempt.endpoint.origin, lastAttempt.endpoint.hostname, lastAttempt.endpoint.pathname] });
      let detail = capturedFailureDetail(original, capture);
      captureRecorded = true;
      try {
        await runtime.captureFailure?.(capture);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        detail = { ...detail, message: `${detail.message} Diagnostic capture failed; this is a local capture fault, not an upstream finding.` };
      }
      console.error('Databricks upstream request failed', detail);
      return detail;
    };
    try {
      let body: Record<string, unknown>;
      try { body = await readBody(request); }
      catch { sendError(response, 400); return; }
      controller.signal.throwIfAborted();
      if (body.model !== modelAlias) { sendError(response, 400); return; }
      // Prefer Responses for tools + effort, but probe the actual passthrough
      // surface. Some gateways advertise MLflow Responses without OpenAI support.
      const effort = requestsEffort(body);
      const measured = measuredGatewayApi(runtime.model);
      let messagesSurface = anthropic || learnedMessages || !invocation && effort
        && (measured === 'anthropic-messages' || responsesUnsupported || !Array.isArray(body.tools) || !body.tools.length);
      let responses = !invocation && !messagesSurface && !measured && !responsesUnsupported && (toolsState === 'unsupported'
        ? runtime.wireCapabilities?.responsesPath !== undefined
        : Array.isArray(body.tools) && body.tools.some((tool) => record(tool) && tool.type === 'function'));
      const headers: Record<string, string> = {
        Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json',
        ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}),
      };
      // Keep certified protocol feature negotiation, not arbitrary child headers.
      if (anthropic && typeof request.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = request.headers['anthropic-beta'];
      let result: Response;
      let carriedTools = false;
      let rejected: unknown;
      let parameterHint: string | undefined;
      const corrections = new Set<string>();
      const correctOnce = (correction: string) => {
        if (corrections.has(correction)) return false;
        corrections.add(correction);
        return true;
      };
      const triedRoutes = new Set<string>();
      let toolsRejected = false;
      const nextToolRoute = (preferMessages = true) => {
        // Actionable tools rejection, never model identity, unlocks Messages.
        if (preferMessages && (toolsRejected || effort) && !anthropic && !triedRoutes.has(messagesPath) && correctOnce('messages-route')) {
          messagesSurface = true; responses = false; return true;
        }
        const next = responsesPaths.find(candidate => !triedRoutes.has(candidate));
        if (next && correctOnce(`route:${next}`)) {
          responsesPath = next; responses = true; messagesSurface = false; responsesUnsupported = false; return true;
        }
        if ((!effort || invocation) && !triedRoutes.has(upstream.pathname) && correctOnce('chat-route')) {
          responses = false; messagesSurface = false; return true;
        }
        return false;
      };
      // Bounded routes plus the existing field/budget corrections and one artifact fallback.
      // Only explicit HTTP 400 validation failures are replayed; never a stream,
      // transport failure, rate limit, or a possibly completed inference.
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        const source = toolsState === 'unsupported' ? artifactDeliveryRequest(body, anthropic) : body;
        const wire = messagesSurface ? anthropic ? nativeMessagesRequest(source) : messagesRequest(source)
          : responses ? responsesRequest(source) : invocation ? { ...source } : gatewayChatRequest(source);
        const route = messagesSurface ? messagesPath : responses ? responsesPath : upstream.pathname;
        triedRoutes.add(route);
        if (!messagesSurface && !responses) {
          if (chatTokensField === 'max_tokens' && wire.max_completion_tokens !== undefined) {
            wire.max_tokens = wire.max_completion_tokens;
            delete wire.max_completion_tokens;
          }
        }
        // Pi needs numeric planning limits, but unknown maxima must never escape
        // as speculative wire budgets. Messages may require one: negotiate a
        // conservative starting budget only after an explicit required-field 400.
        for (const field of OUTPUT_FIELDS) {
          if (runtime.capabilities.maxTokens === null && !requiredOutputBudget && outputLimit === undefined) delete wire[field];
          else if (typeof wire[field] === 'number' && outputLimit !== undefined) wire[field] = Math.min(wire[field], outputLimit);
        }
        const outputField = messagesSurface ? 'max_tokens' : responses ? 'max_output_tokens' : chatTokensField;
        if (runtime.capabilities.maxTokens === null && requiredOutputBudget) wire[outputField] = Math.min(4096, outputLimit ?? 4096);
        for (const field of omittedFields) delete wire[field];
        carriedTools = Array.isArray(wire.tools) && wire.tools.length > 0;
        // Only an invocation URL selects the endpoint without a body model.
        if (invocation && route === upstream.pathname) delete wire.model;
        else wire.model = runtime.model;
        const endpoint = new URL(route, upstream.origin);
        const serializedWire = JSON.stringify(wire);
        const outboundBody: unknown = JSON.parse(serializedWire);
        if (!record(outboundBody)) throw new Error('Invalid serialized request');
        lastAttempt = { endpoint, body: outboundBody, routeKind: invocation && route === upstream.pathname ? 'serving-invocations'
          : messagesSurface ? 'anthropic-messages' : responses ? 'openai-responses' : 'chat-completions' };
        result = await upstreamFetch(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { ...headers, ...(messagesSurface ? { 'anthropic-version': '2023-06-01' } : {}) },
          body: serializedWire,
        });
        upstreamStatus = result.status;
        if (controller.signal.aborted) {
          await result.body?.cancel();
          controller.signal.throwIfAborted();
        }
        if (result.ok) break;
        rejected = await readUpstreamError(result);
        const message = record(rejected) ? rejected.message ?? (record(rejected.error) ? rejected.error.message : undefined) : undefined;
        parameterHint = undefined;
        // A missing route is safe to probe elsewhere, but auth/transport/server
        // failures never establish capability and never replay inference.
        if (result.status === 404 && (responses || messagesSurface && !anthropic) && attempt < 10) {
          if (nextToolRoute()) continue;
          break;
        }
        if (result.status !== 400 || typeof message !== 'string') break;
        // Only fixed parameter names cross the privacy boundary, never provider prose.
        const fields = ['max_completion_tokens', 'max_tokens', 'max_output_tokens', 'max_new_tokens', 'reasoning_effort', 'tools', 'tool_choice', 'stream_options'];
        const named = fields.filter((field) => new RegExp(`\\b${field}\\b`).test(message));
        if (named.length) parameterHint = `Rejected parameter: ${named.join(', ')}.`;
        if (responses && /^Responses API passthrough is not supported for model /.test(message)) {
          parameterHint = 'The endpoint does not support Responses API passthrough.';
          if (attempt < 10) {
            if (!effort && !toolsRejected && !triedRoutes.has(upstream.pathname) && correctOnce('chat-route')) {
              responsesUnsupported = true; responses = false; continue;
            }
            if (nextToolRoute()) continue;
            // Unsupported passthrough is route-local evidence, not tool support.
            break;
          }
        }
        // Live rejection overrides any positive metadata or persisted recipe,
        // including when retries are exhausted or the next route fails.
        if (wire.tools !== undefined && rejectsTools(message)) {
          toolsRejected = true;
          await invalidateTools();
        }
        if (attempt < 10) {
          if (!responses && /Function tools with reasoning_effort are not supported/i.test(message)
            && /(?:use|through)\s+\/?(?:v1\/)?responses\b/i.test(message)) {
            toolsRejected = true;
            if (nextToolRoute(false) || nextToolRoute()) continue;
            break;
          }
          if (wire.tools !== undefined && rejectsTools(message)) {
            toolsRejected = true;
            // Native Pi requests cannot be replayed into Chat without a reverse
            // adapter. Fail rather than falsely declaring all tools unavailable.
            if (anthropic) break;
            if (nextToolRoute()) continue;
            // Only after every known route was tried. A single Chat rejection
            // never means the endpoint lacks tools.
            if (correctOnce('artifact-delivery')) {
              toolsState = 'unsupported';
              // A rejected Messages probe did not establish a new protocol.
              if (invocation) messagesSurface = false;
              continue;
            }
          }
          const unknown = /(?:unknown field|unrecognized (?:request )?(?:argument|field)|unsupported parameter)\s*:?\s*["'](max_completion_tokens|max_tokens|max_output_tokens|stream_options)["']/i.exec(message)?.[1];
          if (unknown && wire[unknown] !== undefined && correctOnce(`field:${unknown}`)) {
            if (!messagesSurface && !responses && unknown === 'max_completion_tokens') chatTokensField = 'max_tokens';
            else omittedFields.add(unknown);
            continue;
          }
          if (runtime.capabilities.maxTokens === null && wire[outputField] === undefined && !requiredOutputBudget
            && new RegExp(`(?:\\b${outputField}\\b["']?\\s*:\\s*Field required|["']?\\b${outputField}\\b["']?\\s+(?:is )?required)`, 'i').test(message)) {
            corrections.add('required-budget');
            requiredOutputBudget = true;
            omittedFields.delete(outputField);
            continue;
          }
          const limit = outputCeiling(message);
          // The caller may already use max_tokens before field negotiation has
          // changed chatTokensField. Inspect actual wire budgets, not that preference.
          if (limit !== undefined && OUTPUT_FIELDS.some(field => typeof wire[field] === 'number' && wire[field] > limit)
            && correctOnce(`ceiling:${limit}`)) {
            outputLimit = limit;
            continue;
          }
        }
        break;
      }
      const learnCompleted = async () => {
        if (messagesSurface) learnedMessages = true;
        if (carriedTools) toolsState = 'supported';
        // A field correction on a tool-free turn is not positive tool evidence.
        const learned = learnedCapabilities(responses, messagesSurface);
        if (!carriedTools && toolsState === 'supported') {
          delete learned.tools;
          delete learned.toolsCompletionVersion;
        }
        if (corrections.size || carriedTools) await runtime.onCapabilitiesLearned?.(learned);
      };
      if (!result.ok) {
        const original = upstreamFailure(result.status, rejected, privateValues);
        const captured = await captureAttempt(original, rejected);
        const detail = !captured.upstreamMessage && parameterHint ? failureDetail(original.reason, result.status, parameterHint) : captured;
        // Report the authoritative HTTP failure even if credential invalidation fails.
        try { if (result.status === 401) await runtime.onAuthRejected?.(); }
        finally { sendError(response, result.status >= 400 && result.status <= 599 ? result.status : 502, detail); }
      } else if (result.headers.get('content-type')?.includes('text/event-stream')) {
        await forwardStream(result, response, controller.signal, responses, messagesSurface && !anthropic);
        await learnCompleted();
        response.end();
      } else {
        const payload: unknown = await result.json();
        controller.signal.throwIfAborted();
        if (record(payload) && (payload.error || payload.type === 'error')) throw streamError(result.status, payload);
        if (!record(payload)) throw new Error('Invalid upstream response');
        const translated = messagesSurface && !anthropic ? messagesResponse(payload)
          : responses ? chatResponse(payload) : anthropic ? payload : normalizeChatContent(payload);
        if (carriedTools && !(anthropic ? payload.type === 'message' && typeof payload.stop_reason === 'string'
          : Array.isArray(translated.choices) && translated.choices.length > 0
            && translated.choices.every(choice => record(choice) && record(choice.message) && typeof choice.finish_reason === 'string'))) {
          throw new Error('Incomplete upstream response');
        }
        await learnCompleted();
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(sanitize(translated)));
      }
    } catch (error) {
      const original = error instanceof UpstreamStreamError ? error.detail
        : failureDetail(upstreamStatus === null ? 'transport' : 'invalid-response', upstreamStatus);
      const detail = await captureAttempt(original, error instanceof UpstreamStreamError ? error.payload : undefined);
      try { if (error instanceof UpstreamStreamError && error.toolsRejected) await invalidateTools(); }
      finally {
        if (!controller.signal.aborted && !response.writableEnded) sendError(response, 502, detail);
      }
    } finally {
      clearTimeout(timeout);
      response.off('close', abort);
      request.off('aborted', abort);
      controller.abort();
      active.delete(controller);
    }
  }

  const server = createServer((request, response) => {
    const task = handle(request, response).finally(() => { requests.delete(task); });
    requests.add(task);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const { port } = await listenOnFetchCompatiblePort(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`, capabilityKey, modelAlias,
    close: () => closing ??= (async () => {
      closed = true;
      // Revoke ingress, cancel producers, then await both socket and producer
      // disposal. A listener close event alone says nothing about pending fetches.
      const listenerClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await Promise.all([listenerClosed, ...requests]);
    })(),
  };
}
