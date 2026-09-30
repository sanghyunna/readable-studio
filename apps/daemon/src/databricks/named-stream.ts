import { NamedProbeError, record } from './named-failure.js';

/** Consume terminal evidence, not just a 200 or an opening tool delta. */
export async function readNamedStream(response: Response, signal: AbortSignal): Promise<{ tools: boolean }> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new NamedProbeError('incomplete-response', response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let size = 0; let terminal = false; let normal = false; let text = '';
  const calls = new Map<number, { name: string; arguments: string; input?: unknown }>();
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation ??= reader.cancel();
    // Observe immediately, then propagate cancellation errors from the finally block.
    void cancellation.catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const frame = (raw: string) => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { terminal = true; return; }
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new NamedProbeError('incomplete-response', 200); }
    const payload = record(value);
    if (payload.error || payload.type === 'error' || /^event:\s*error/m.test(raw)) throw new NamedProbeError('incomplete-response', response.status);
    if (payload.type === 'message_stop') terminal = true;
    if (payload.type === 'message_delta') {
      const stop = record(payload.delta).stop_reason;
      if (stop === 'max_tokens') throw new NamedProbeError('incomplete-response', 200);
      if (stop === 'end_turn' || stop === 'tool_use' || stop === 'stop_sequence') normal = true;
    }
    if (payload.type === 'content_block_start') {
      const block = record(payload.content_block);
      if (block.type === 'tool_use' && typeof payload.index === 'number') calls.set(payload.index, { name: String(block.name), arguments: '', input: block.input });
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    }
    if (payload.type === 'content_block_delta') {
      const delta = record(payload.delta);
      if (typeof delta.text === 'string') text += delta.text;
      const call = calls.get(Number(payload.index));
      if (call && typeof delta.partial_json === 'string') call.arguments += delta.partial_json;
    }
    if (Array.isArray(payload.choices)) for (const rawChoice of payload.choices) {
      const choice = record(rawChoice); const delta = record(choice.delta);
      if (choice.finish_reason === 'length') throw new NamedProbeError('incomplete-response', 200);
      if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') normal = true;
      if (typeof delta.content === 'string') text += delta.content;
      if (Array.isArray(delta.tool_calls)) for (const rawCall of delta.tool_calls) {
        const call = record(rawCall); const fn = record(call.function);
        if (typeof call.index !== 'number') throw new NamedProbeError('incomplete-response', 200);
        const previous = calls.get(call.index) ?? { name: '', arguments: '' };
        if (typeof fn.name === 'string') previous.name += fn.name;
        if (typeof fn.arguments === 'string') previous.arguments += fn.arguments;
        calls.set(call.index, previous);
      }
    }
  };
  try {
    while (true) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) throw new NamedProbeError('incomplete-response', 200);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) { frame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); }
    }
    buffer += decoder.decode(); if (buffer.trim()) frame(buffer);
    if (!terminal || !normal) throw new NamedProbeError('incomplete-response', 200);
    let tools = false;
    for (const call of calls.values()) {
      let input = call.input;
      try { if (call.arguments) input = JSON.parse(call.arguments); } catch { throw new NamedProbeError('incomplete-response', 200); }
      if (call.name === 'readable_probe' && record(input).ok === true) tools = true;
    }
    if (!tools && !text.trim()) throw new NamedProbeError('incomplete-response', 200);
    return { tools };
  } finally { signal.removeEventListener('abort', abort); try { await (cancellation ?? reader.cancel()); } finally { reader.releaseLock(); } }
}
