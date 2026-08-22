import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePiModels, mapPiRpcEvent, attachPiRpcSession } from '../src/pi-rpc.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';

// ─── parsePiModels ─────────────────────────────────────────────────────────

test('parsePiModels parses TSV table with default option prepended', () => {
  const input =
    'provider         model                  context  max-out  thinking  images\n' +
    'anthropic        claude-sonnet-4-5       200K      64K      yes        yes\n' +
    'openai           gpt-5                  128K      16K      yes        yes\n';

  const result = parsePiModels(input);

  assert.ok(result);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { id: 'default', label: 'Default (CLI config)' });
  assert.equal(result[1]?.id, 'anthropic/claude-sonnet-4-5');
  assert.equal(result[2]?.id, 'openai/gpt-5');
});

test('parsePiModels deduplicates identical provider/model pairs', () => {
  const input =
    'provider         model                  context  max-out  thinking  images\n' +
    'openrouter       claude-sonnet-4-5       200K      64K      yes        yes\n' +
    'openrouter       claude-sonnet-4-5       200K      64K      yes        yes\n';

  const result = parsePiModels(input);

  assert.ok(result);
  assert.equal(result.length, 2); // default + 1 unique
  assert.equal(result[1]?.id, 'openrouter/claude-sonnet-4-5');
});

test('parsePiModels returns null for empty input', () => {
  assert.equal(parsePiModels(''), null);
  assert.equal(parsePiModels(null), null);
  assert.equal(parsePiModels(undefined), null);
});

test('parsePiModels returns null for header-only input (no model rows)', () => {
  const input =
    'provider         model                  context  max-out  thinking  images\n';
  assert.equal(parsePiModels(input), null);
});

test('parsePiModels skips lines with fewer than 2 columns', () => {
  const input =
    'provider         model                  context  max-out  thinking  images\n' +
    'solo-field\n' +
    'anthropic        claude-sonnet-4-5       200K      64K      yes        yes\n';

  const result = parsePiModels(input);

  assert.ok(result);
  assert.equal(result.length, 2); // default + 1 valid
  assert.equal(result[1]?.id, 'anthropic/claude-sonnet-4-5');
});

test('parsePiModels handles comment lines', () => {
  const input =
    '# this is a comment\n' +
    'provider         model                  context  max-out  thinking  images\n' +
    'anthropic        claude-sonnet-4-5       200K      64K      yes        yes\n';

  const result = parsePiModels(input);

  assert.ok(result);
  assert.equal(result.length, 2);
  assert.equal(result[1]?.id, 'anthropic/claude-sonnet-4-5');
});

test('parsePiModels handles large model lists', () => {
  const header = 'provider         model                  context  max-out  thinking  images\n';
  const rows = Array.from({ length: 600 }, (_, i) =>
    `provider${i % 5}        model-${i}       128K      16K      yes        no\n`,
  ).join('');
  const input = header + rows;

  const result = parsePiModels(input);

  assert.ok(result);
  assert.equal(result[0]?.id, 'default');
  assert.equal(result.length, 601); // default + 600
});

test('parsePiModels skips duplicate default id', () => {
  const input =
    'provider         model                  context  max-out  thinking  images\n' +
    'default          some-model              128K      16K      yes        no\n' +
    'anthropic        claude-sonnet-4-5       200K      64K      yes        yes\n';

  const result = parsePiModels(input);

  assert.ok(result);
  assert.equal(result.length, 3); // synthetic default + default/some-model + anthropic/claude-sonnet-4-5
  assert.equal(result[0]?.id, 'default');
  assert.equal(result[1]?.id, 'default/some-model');
});

// ─── RPC event translation (mapPiRpcEvent) ────────────────────────────────
//
// We test the pure event mapper directly — no child process, no stdin.
// This catches regressions like tool event ordering bugs.

import { createJsonLineStream } from '../src/acp.js';

type JsonRecord = Record<string, unknown>;
type TestAgentEvent = JsonRecord & { type?: string; label?: string; message?: string; delta?: string };
type TestSentEvent = TestAgentEvent & { channel?: string };
type MockWritable = Pick<Writable, 'write'>;
type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  signals: Array<NodeJS.Signals | number | undefined>;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};

function asRecord(value: unknown): JsonRecord {
  assert.ok(value && typeof value === 'object');
  return value as JsonRecord;
}

function parseJsonRecord(line: string): JsonRecord {
  return asRecord(JSON.parse(line) as unknown);
}

function eventAt(events: TestAgentEvent[], index: number): TestAgentEvent {
  const event = events[index];
  assert.ok(event, `expected event at index ${index}`);
  return event;
}

function usageOf(event: TestAgentEvent): JsonRecord {
  return asRecord(event.usage);
}

function imagesOf(parsed: JsonRecord): JsonRecord[] {
  assert.ok(Array.isArray(parsed.images));
  return parsed.images.map((image) => asRecord(image));
}

function simulateRpcSession(rpcLines: JsonRecord[]): TestAgentEvent[] {
  const events: TestAgentEvent[] = [];
  const send = (_channel: string, payload: JsonRecord) => {
    events.push(payload);
  };
  const ctx = { runStartedAt: Date.now(), sentFirstToken: { value: false } };

  const parser = createJsonLineStream((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const event = raw as JsonRecord;
    // Skip non-agent events that mapPiRpcEvent doesn't handle.
    if (event.type === 'extension_ui_request') return;
    if (event.type === 'response') return;

    mapPiRpcEvent(event, send, ctx);
  });

  const input = rpcLines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  parser.feed(input);
  parser.flush();
  return events;
}

test('pi RPC: text streaming from message_update events', () => {
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello ' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'world' },
    },
  ]);

  assert.deepEqual(events, [
    { type: 'status', label: 'working' },
    { type: 'status', label: 'thinking' },
    { type: 'status', label: 'streaming', ttftMs: eventAt(events, 2).ttftMs },
    { type: 'text_delta', delta: 'Hello ' },
    { type: 'text_delta', delta: 'world' },
  ]);
});

test('pi RPC: thinking events are mapped correctly', () => {
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm...' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 },
    },
  ]);

  assert.deepEqual(events, [
    { type: 'status', label: 'working' },
    { type: 'status', label: 'thinking' },
    { type: 'thinking_start' },
    { type: 'thinking_delta', delta: 'hmm...' },
    { type: 'thinking_end' },
  ]);
});

test('pi RPC: usage extracted from turn_end', () => {
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, totalTokens: 175 },
      },
    },
  ]);

  assert.equal(events.length, 3);
  assert.equal(eventAt(events, 2).type, 'usage');
  assert.deepEqual(eventAt(events, 2).usage, {
    input_tokens: 100,
    output_tokens: 50,
    cached_read_tokens: 20,
    cached_write_tokens: 5,
    total_tokens: 175,
  });
});

test('pi RPC: turn_end assistant error maps to visible error event', () => {
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'openai-compatible-provider',
        model: 'example-model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'error',
        errorMessage: 'Upstream provider rejected the request',
      },
    },
  ]);

  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent, 'turn_end stopReason=error should fail visibly instead of completing empty');
  assert.equal(errorEvent.message, 'Upstream provider rejected the request');
});

test('pi RPC: tool execution events mapped correctly', () => {
  const events = simulateRpcSession([
    { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'foo.txt' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'file contents here' }] },
      isError: false,
    },
  ]);

  assert.deepEqual(events, [
    { type: 'tool_use', id: 'tc-1', name: 'read', input: { path: 'foo.txt' } },
    { type: 'tool_result', toolUseId: 'tc-1', content: 'file contents here', isError: false },
  ]);
});

test('pi RPC: tool error results flagged correctly', () => {
  const events = simulateRpcSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'tc-2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'command not found' }] },
      isError: true,
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).isError, true);
});

test('pi RPC: compaction and retry status events', () => {
  const events = simulateRpcSession([
    { type: 'compaction_start' },
    { type: 'auto_retry_start' },
  ]);

  assert.deepEqual(events, [
    { type: 'status', label: 'compacting' },
    { type: 'status', label: 'retrying' },
  ]);
});

test('pi RPC: extension UI fire-and-forget events are silently consumed', () => {
  const events = simulateRpcSession([
    { type: 'extension_ui_request', id: 'ui-1', method: 'setStatus', statusKey: 'foo', statusText: 'bar' },
    { type: 'extension_ui_request', id: 'ui-2', method: 'setWidget', widgetKey: 'baz' },
    { type: 'agent_start' },
  ]);

  // Only agent_start should produce an event; the UI requests are consumed.
  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'status');
  assert.equal(eventAt(events, 0).label, 'working');
});

test('pi RPC: response events are silently consumed', () => {
  const events = simulateRpcSession([
    { type: 'response', command: 'prompt', success: true },
    { type: 'agent_start' },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).label, 'working');
});

test('pi RPC: full multi-turn session with tools and usage', () => {
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Let me check.' },
    },
    { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'file1.txt\nfile2.txt' }] },
      isError: false,
    },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 230 },
      },
    },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Done!' },
    },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 300, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 405 },
      },
    },
  ]);

  // 2 turns with text, tool_use/tool_result, and usage
  assert.ok(events.some((e) => e.type === 'text_delta' && e.delta === 'Let me check.'));
  assert.ok(events.some((e) => e.type === 'tool_use' && e.id === 'tc-1' && e.name === 'bash'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.toolUseId === 'tc-1'));
  assert.ok(events.some((e) => e.type === 'text_delta' && e.delta === 'Done!'));
  // Usage from both turns
  const usageEvents = events.filter((e) => e.type === 'usage');
  assert.equal(usageEvents.length, 2);
  assert.equal(usageOf(eventAt(usageEvents, 0)).input_tokens, 200);
  assert.equal(usageOf(eventAt(usageEvents, 1)).cached_read_tokens, 100);
});

test('pi RPC: tool_use arrives before tool_result in event order', () => {
  // Regression: tool_use must be emitted from tool_execution_start,
  // not message_end, so the UI can pair it with the later tool_result.
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'read', args: { path: 'a.txt' } },
    { type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'read', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
  ]);

  const toolUseIdx = events.findIndex((e) => e.type === 'tool_use');
  const toolResultIdx = events.findIndex((e) => e.type === 'tool_result');
  assert.ok(toolUseIdx !== -1, 'tool_use event should exist');
  assert.ok(toolResultIdx !== -1, 'tool_result event should exist');
  assert.ok(toolUseIdx < toolResultIdx, 'tool_use must arrive before tool_result');
});

// ─── sendCommand format ─────────────────────────────────────────────────────

test('pi RPC: sendCommand writes well-formed pi command JSON', async () => {
  // We test the wire format by capturing what gets written to a mock writable.
  const written: string[] = [];
  const mockWritable = {
    write(data: string) {
      written.push(data);
      return true;
    },
  };

  // Inline the sendCommand logic (same as in pi-rpc.js)
  let nextId = 1;
  function sendCommand(writable: MockWritable, type: string, params: JsonRecord = {}) {
    const id = nextId++;
    writable.write(`${JSON.stringify({ id, type, ...params })}\n`);
    return id;
  }

  const id = sendCommand(mockWritable, 'prompt', { message: 'hello' });

  assert.equal(id, 1);
  assert.equal(written.length, 1);
  const parsed = parseJsonRecord(written[0] ?? '');
  assert.equal(parsed.type, 'prompt');
  assert.equal(parsed.id, 1);
  assert.equal(parsed.message, 'hello');
});

test('pi RPC: sendCommand increments ids across calls', () => {
  const written: string[] = [];
  const mockWritable = { write(data: string) { written.push(data); return true; } };

  let nextId = 1;
  function sendCommand(writable: MockWritable, type: string, params: JsonRecord = {}) {
    const id = nextId++;
    writable.write(`${JSON.stringify({ id, type, ...params })}\n`);
    return id;
  }

  const id1 = sendCommand(mockWritable, 'prompt', { message: 'a' });
  const id2 = sendCommand(mockWritable, 'steer', { message: 'b' });

  assert.equal(id1, 1);
  assert.equal(id2, 2);
  const p1 = parseJsonRecord(written[0] ?? '');
  const p2 = parseJsonRecord(written[1] ?? '');
  assert.equal(p1.type, 'prompt');
  assert.equal(p2.type, 'steer');
});

test('pi RPC: concurrent sessions get independent id sequences', () => {
  // Each session has its own nextRpcId counter, so two sessions
  // spawned at the same time get non-colliding ids.
  const written1: string[] = [];
  const written2: string[] = [];
  const mock1 = { write(data: string) { written1.push(data); return true; } };
  const mock2 = { write(data: string) { written2.push(data); return true; } };

  // Session 1
  let nextId1 = 1;
  function send1(w: MockWritable, type: string, params: JsonRecord = {}) {
    const id = nextId1++;
    w.write(`${JSON.stringify({ id, type, ...params })}\n`);
    return id;
  }
  // Session 2
  let nextId2 = 1;
  function send2(w: MockWritable, type: string, params: JsonRecord = {}) {
    const id = nextId2++;
    w.write(`${JSON.stringify({ id, type, ...params })}\n`);
    return id;
  }

  const id1 = send1(mock1, 'prompt', { message: 'hello' });
  const id2 = send2(mock2, 'prompt', { message: 'world' });

  assert.equal(id1, 1);
  assert.equal(id2, 1); // independent counter
  const p1 = parseJsonRecord(written1[0] ?? '');
  const p2 = parseJsonRecord(written2[0] ?? '');
  assert.equal(p1.id, 1);
  assert.equal(p2.id, 1);
});

test('pi RPC: no duplicate usage when both message_end and turn_end carry usage', () => {
  // Regression: pi emits both message_end and turn_end per turn,
  // both carrying usage. We must only emit from turn_end to avoid
  // double-counting. See Copilot review PR #117.
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
      },
    },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
      },
    },
  ]);

  const usageEvents = events.filter((e) => e.type === 'usage');
  assert.equal(usageEvents.length, 1, 'should emit exactly one usage event per turn');
  assert.equal(usageOf(eventAt(usageEvents, 0)).input_tokens, 100);
});

// ─── attachPiRpcSession integration tests ──────────────────────────────────
//
// These exercise the real attachPiRpcSession against a mock child process
// so regressions in the actual function (wrong events, missing model
// normalization, abort not writing to stdin, etc.) are caught.

function createMockChild(options: { closeOn?: NodeJS.Signals | 'any' } = {}): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.signals = [];
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.signals.push(signal);
    if ((options.closeOn ?? 'any') === 'any' || options.closeOn === signal) {
      child.emit('close', null, signal);
    }
    return true;
  };
  return child;
}

function createSession(childOpts: { model?: string | null } = {}) {
  const events: TestSentEvent[] = [];
  const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
  const model = childOpts.model ?? null;
  const child = createMockChild();

  const session = attachPiRpcSession({
    child: child as unknown as ChildProcess,
    prompt: 'test prompt',
    cwd: '/tmp',
    model,
    send,
  });

  return { child, session, events, send };
}

function feedStdoutLines(child: MockChildProcess, lines: JsonRecord[]) {
  const input = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  child.stdout.write(input);
}

function closeStdout(child: MockChildProcess) {
  child.stdout.end();
  child.stdin.end();
}

test('attachPiRpcSession emits status:initializing with model name', () => {
  const { events } = createSession({ model: 'anthropic/claude-sonnet-4-5' });

  const init = events.find(
    (e) => e.channel === 'agent' && e.type === 'status' && e.label === 'initializing',
  );
  assert.ok(init, 'should emit status:initializing');
  assert.equal(init.model, 'anthropic/claude-sonnet-4-5');
});

test('attachPiRpcSession emits status:initializing with null model when model is null', () => {
  const { events } = createSession({ model: null });

  const init = events.find(
    (e) => e.channel === 'agent' && e.type === 'status' && e.label === 'initializing',
  );
  assert.ok(init, 'should emit status:initializing');
  assert.equal(init.model, null);
});

test('attachPiRpcSession sends prompt command on stdin', () => {
  const { child } = createSession();

  // Read what was written to stdin — the first line should be a prompt command.
  const chunks: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  // stdin already received the prompt write; PassThrough buffers it.
  const buffered = child.stdin.read();
  if (buffered) chunks.push(buffered.toString());

  const lines = chunks.join('').trim().split('\n');
  const promptLine = lines.find((l) => {
    try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
  });
  assert.ok(promptLine, 'should send a prompt command on stdin');
  const parsed = parseJsonRecord(promptLine);
  assert.equal(parsed.type, 'prompt');
  assert.equal(parsed.message, 'test prompt');
});

test('attachPiRpcSession abort() writes well-formed abort command to stdin', () => {
  const { child, session } = createSession();

  // Drain any buffered stdin data (the prompt command) before abort.
  child.stdin.read();

  const chunks: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  session.abort();

  // Read the abort command from stdin buffer.
  const buffered = child.stdin.read();
  if (buffered) chunks.push(buffered.toString());

  const lines = chunks.join('').trim().split('\n');
  const abortLine = lines.find((l) => {
    try { return parseJsonRecord(l).type === 'abort'; } catch { return false; }
  });
  assert.ok(abortLine, 'should send an abort command on stdin');
  const parsed = parseJsonRecord(abortLine);
  assert.equal(parsed.type, 'abort');
  assert.equal(typeof parsed.id, 'number');
});

test('attachPiRpcSession abort() is idempotent and no-op after stdin close', () => {
  const { child, session } = createSession();

  // Drain buffered data.
  child.stdin.read();

  // Close stdin (simulates pi process exiting).
  child.stdin.end();
  child.stdin.emit('close');

  const chunks: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  // abort() should be a no-op because finished is already true or stdin is closed.
  session.abort();
  session.abort(); // idempotent

  const buffered = child.stdin.read();
  assert.equal(buffered, null, 'no bytes should be written after abort on closed stdin');
});

// ─── extension_error event handling ─────────────────────────────────────────

test('pi RPC: extension_error maps to error event', () => {
  const events = simulateRpcSession([
    { type: 'extension_error', extensionPath: '/path/to/ext.ts', event: 'tool_call', error: 'Something broke' },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'Something broke');
});

test('pi RPC: extension_error with non-string error uses fallback', () => {
  const events = simulateRpcSession([
    { type: 'extension_error', extensionPath: '/path/to/ext.ts', error: { message: 'nested' } },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'Extension error');
});

test('pi RPC: extension_error with missing error uses fallback', () => {
  const events = simulateRpcSession([
    { type: 'extension_error', extensionPath: '/path/to/ext.ts' },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'Extension error');
});

// ─── message_update error delta handling ────────────────────────────────────

test('pi RPC: message_update with error delta maps to error event', () => {
  const events = simulateRpcSession([
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'error', reason: 'aborted' },
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'aborted');
});

test('pi RPC: message_update error delta falls back to delta text', () => {
  const events = simulateRpcSession([
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'error', delta: 'Connection reset' },
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'Connection reset');
});

test('pi RPC: message_update error delta with no reason or delta uses fallback', () => {
  const events = simulateRpcSession([
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'error' },
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'Agent error');
});

test('pi RPC: message_update error after partial output still emits error', () => {
  // Even after text deltas have been emitted (agentProducedOutput = true
  // on the server side), a subsequent error delta should still surface
  // so the run flips to failed rather than succeeding with a partial
  // response.
  const events = simulateRpcSession([
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial output' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'error', reason: 'context_overflow' },
    },
  ]);

  // status:working, status:thinking, status:streaming, text_delta, error
  assert.equal(events.length, 5);
  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent, 'should emit an error event after partial output');
  assert.equal(errorEvent.message, 'context_overflow');
});

// ─── auto_retry_end failure event handling ────────────────────────────────────

test('pi RPC: auto_retry_end with success=false maps to error event', () => {
  const events = simulateRpcSession([
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'overloaded' },
    { type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded_error: Overloaded' },
  ]);

  // auto_retry_start → status:retrying, auto_retry_end → error
  assert.equal(events.length, 2);
  assert.equal(eventAt(events, 0).type, 'status');
  assert.equal(eventAt(events, 0).label, 'retrying');
  assert.equal(eventAt(events, 1).type, 'error');
  assert.equal(eventAt(events, 1).message, '529 overloaded_error: Overloaded');
});

test('pi RPC: auto_retry_end with success=true does not emit error', () => {
  const events = simulateRpcSession([
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'overloaded' },
    { type: 'auto_retry_end', success: true, attempt: 2 },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'status');
  assert.equal(eventAt(events, 0).label, 'retrying');
});

test('pi RPC: auto_retry_end failure with missing finalError uses fallback', () => {
  const events = simulateRpcSession([
    { type: 'auto_retry_end', success: false, attempt: 3 },
  ]);

  assert.equal(events.length, 1);
  assert.equal(eventAt(events, 0).type, 'error');
  assert.equal(eventAt(events, 0).message, 'Auto-retry exhausted');
});

// ─── imagePaths forwarding in attachPiRpcSession ─────────────────────────────

test('attachPiRpcSession sends prompt with images when imagePaths provided', async () => {
  const { child } = createSession();

  // Create a small test image file.
  const tmpDir = await import('node:os').then((m) => m.tmpdir());
  const tmpFile = path.join(tmpDir, `pi-rpc-test-${Date.now()}.png`);
  await import('node:fs/promises').then((fsp) =>
    fsp.writeFile(tmpFile, Buffer.from('iVBORw0KGgo=', 'base64')),
  );

  try {
    const events2: TestSentEvent[] = [];
    const send2 = (channel: string, payload: JsonRecord) => events2.push({ channel, ...payload });
    const child2 = createMockChild();

    attachPiRpcSession({
      child: child2 as unknown as ChildProcess,
      prompt: 'describe this image',
      cwd: '/tmp',
      model: null,
      send: send2,
      imagePaths: [tmpFile],
    });

    // Read the stdin data to find the prompt command.
    const chunks: string[] = [];
    child2.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const buffered = child2.stdin.read();
    if (buffered) chunks.push(buffered.toString());

    const lines = chunks.join('').trim().split('\n');
    const promptLine = lines.find((l) => {
      try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
    });
    assert.ok(promptLine, 'should send a prompt command');
    const parsed = parseJsonRecord(promptLine);
    const images = imagesOf(parsed);
    assert.equal(images.length, 1);
    assert.equal(images[0]?.type, 'image');
    assert.equal(images[0]?.mimeType, 'image/png');
    assert.ok(typeof images[0]?.data === 'string' && images[0].data.length > 0);
  } finally {
    await import('node:fs/promises').then((fsp) => fsp.unlink(tmpFile).catch(() => {}));
  }
});

test('attachPiRpcSession sends prompt without images when imagePaths is empty', () => {
  const events: TestSentEvent[] = [];
  const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
  const child = createMockChild();

  attachPiRpcSession({
    child: child as unknown as ChildProcess,
    prompt: 'hello',
    cwd: '/tmp',
    model: null,
    send,
    imagePaths: [],
  });

  const chunks: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const buffered = child.stdin.read();
  if (buffered) chunks.push(buffered.toString());

  const lines = chunks.join('').trim().split('\n');
  const promptLine = lines.find((l) => {
    try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
  });
  assert.ok(promptLine, 'should send a prompt command');
  const parsed = parseJsonRecord(promptLine);
  assert.equal(parsed.images, undefined, 'prompt should not include images when none provided');
});

test('attachPiRpcSession skips unreadable image paths gracefully', () => {
  const events: TestSentEvent[] = [];
  const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
  const child = createMockChild();

  attachPiRpcSession({
    child: child as unknown as ChildProcess,
    prompt: 'check this',
    cwd: '/tmp',
    model: null,
    send,
    imagePaths: ['/nonexistent/path/fake-image.png'],
  });

  const chunks: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const buffered = child.stdin.read();
  if (buffered) chunks.push(buffered.toString());

  const lines = chunks.join('').trim().split('\n');
  const promptLine = lines.find((l) => {
    try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
  });
  assert.ok(promptLine, 'should send a prompt command');
  const parsed = parseJsonRecord(promptLine);
  assert.equal(parsed.images, undefined, 'prompt should not include images for unreadable paths');
});

test('attachPiRpcSession rejects non-file image paths (directories)', async () => {
  const fsp = await import('node:fs/promises');
  const tmpDir = await import('node:os').then((m) => m.tmpdir());
  const dirPath = path.join(tmpDir, `pi-rpc-test-dir-${Date.now()}`);
  await fsp.mkdir(dirPath);
  try {
    const events: TestSentEvent[] = [];
    const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
    const child = createMockChild();

    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'check this dir',
      cwd: '/tmp',
      model: null,
      send,
      imagePaths: [dirPath],
    });

    const chunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const buffered = child.stdin.read();
    if (buffered) chunks.push(buffered.toString());

    const lines = chunks.join('').trim().split('\n');
    const promptLine = lines.find((l) => {
      try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
    });
    assert.ok(promptLine);
    const parsed = parseJsonRecord(promptLine);
    assert.equal(parsed.images, undefined, 'directories should not be forwarded as images');
  } finally {
    await fsp.rmdir(dirPath);
  }
});

test('attachPiRpcSession rejects disallowed image extensions', async () => {
  const fsp = await import('node:fs/promises');
  const tmpDir = await import('node:os').then((m) => m.tmpdir());
  const tmpFile = path.join(tmpDir, `pi-rpc-test-${Date.now()}.txt`);
  await fsp.writeFile(tmpFile, 'not an image');
  try {
    const events: TestSentEvent[] = [];
    const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
    const child = createMockChild();

    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'what is this',
      cwd: '/tmp',
      model: null,
      send,
      imagePaths: [tmpFile],
    });

    const chunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const buffered = child.stdin.read();
    if (buffered) chunks.push(buffered.toString());

    const lines = chunks.join('').trim().split('\n');
    const promptLine = lines.find((l) => {
      try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
    });
    assert.ok(promptLine);
    const parsed = parseJsonRecord(promptLine);
    assert.equal(parsed.images, undefined, '.txt files should not be forwarded as images');
  } finally {
    await fsp.unlink(tmpFile);
  }
});

test('attachPiRpcSession rejects symlink escape outside uploadRoot', async () => {
  const fsp = await import('node:fs/promises');
  const tmpDir = await import('node:os').then((m) => m.tmpdir());
  // Create a real image file outside the upload root.
  const outsideDir = path.join(tmpDir, `pi-rpc-test-outside-${Date.now()}`);
  await fsp.mkdir(outsideDir);
  const outsideFile = path.join(outsideDir, 'real.jpg');
  await fsp.writeFile(outsideFile, Buffer.from('fake-jpg-content'));
  // Create the upload root and a symlink inside it pointing outside.
  const uploadRoot = path.join(tmpDir, `pi-rpc-test-uploads-${Date.now()}`);
  await fsp.mkdir(uploadRoot);
  const symlinkPath = path.join(uploadRoot, 'escape.jpg');
  await fsp.symlink(outsideFile, symlinkPath);
  try {
    const events: TestSentEvent[] = [];
    const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
    const child = createMockChild();

    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'check this',
      cwd: '/tmp',
      model: null,
      send,
      imagePaths: [symlinkPath],
      uploadRoot,
    });

    const chunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const buffered = child.stdin.read();
    if (buffered) chunks.push(buffered.toString());

    const lines = chunks.join('').trim().split('\n');
    const promptLine = lines.find((l) => {
      try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
    });
    assert.ok(promptLine);
    const parsed = parseJsonRecord(promptLine);
    assert.equal(parsed.images, undefined, 'symlinks resolving outside uploadRoot should not be forwarded as images');
  } finally {
    await fsp.unlink(symlinkPath);
    await fsp.rmdir(uploadRoot);
    await fsp.unlink(outsideFile);
    await fsp.rmdir(outsideDir);
  }
});

test('attachPiRpcSession allows symlink inside uploadRoot', async () => {
  const fsp = await import('node:fs/promises');
  const tmpDir = await import('node:os').then((m) => m.tmpdir());
  // Create a real image file inside the upload root.
  const uploadRoot = path.join(tmpDir, `pi-rpc-test-uploads-in-${Date.now()}`);
  await fsp.mkdir(uploadRoot);
  const realFile = path.join(uploadRoot, 'real.png');
  // Minimal valid PNG header + IHDR so the content isn't empty.
  await fsp.writeFile(realFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // Create a symlink inside the same root pointing to the real file.
  const symlinkPath = path.join(uploadRoot, 'link.png');
  await fsp.symlink(realFile, symlinkPath);
  try {
    const events: TestSentEvent[] = [];
    const send = (channel: string, payload: JsonRecord) => events.push({ channel, ...payload });
    const child = createMockChild();

    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'check this',
      cwd: '/tmp',
      model: null,
      send,
      imagePaths: [symlinkPath],
      uploadRoot,
    });

    const chunks: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const buffered = child.stdin.read();
    if (buffered) chunks.push(buffered.toString());

    const lines = chunks.join('').trim().split('\n');
    const promptLine = lines.find((l) => {
      try { return parseJsonRecord(l).type === 'prompt'; } catch { return false; }
    });
    assert.ok(promptLine);
    const parsed = parseJsonRecord(promptLine);
    assert.ok(Array.isArray(parsed.images), 'symlink inside uploadRoot should be forwarded as image');
    assert.equal(parsed.images.length, 1);
    assert.equal(parsed.images[0].type, 'image');
    assert.equal(parsed.images[0].mimeType, 'image/png');
  } finally {
    await fsp.unlink(symlinkPath);
    await fsp.unlink(realFile);
    await fsp.rmdir(uploadRoot);
  }
});

// ─── original test continues ────────────────────────────────────────────────

test('attachPiRpcSession: no agent events emitted after abort()', () => {
  const { child, events, session } = createSession();

  // Feed normal session events.
  feedStdoutLines(child, [
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Thinking...' },
    },
  ]);

  const beforeCount = events.length;
  assert.ok(beforeCount > 0, 'should have events before abort');

  // Abort — sets finished = true, gates further stdout events.
  session.abort();

  // Feed more agent events that arrive during the abort grace window.
  feedStdoutLines(child, [
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Should not appear' },
    },
    { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { command: 'ls' } },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'More text' },
    },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      },
    },
    { type: 'agent_end' },
  ]);
  closeStdout(child);

  // No new agent events should have been emitted after abort.
  assert.equal(events.length, beforeCount, 'no events should be emitted after abort');
  assert.ok(
    events.every((e) => e.delta !== 'Should not appear' && e.delta !== 'More text'),
    'post-abort text must not appear in events',
  );
});

// ─── semantic resume and settled session capture ───────────────────

async function createPiSessionFixture(options: {
  parentSession?: string;
  cwd?: string;
} = {}) {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-rpc-session-'));
  const cwd = options.cwd ?? path.join(root, 'project');
  await fsp.mkdir(cwd, { recursive: true });
  const sessionPath = path.join(root, 'session.jsonl');
  await fsp.writeFile(sessionPath, `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'fixture-session',
    timestamp: '2026-08-06T00:00:00.000Z',
    cwd,
    ...(options.parentSession ? { parentSession: options.parentSession } : {}),
  })}\n`);
  return { root, cwd, sessionPath, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

function readCommands(child: MockChildProcess): JsonRecord[] {
  const chunk = child.stdin.read();
  return chunk
    ? chunk.toString().trim().split('\n').filter(Boolean).map((line: string) => parseJsonRecord(line))
    : [];
}

test('attachPiRpcSession semantically resumes with switch_session before prompt', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'latest turn only',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: (channel, payload) => events.push({ channel, ...payload }),
    });

    const [resume] = readCommands(child);
    assert.equal(resume?.type, 'switch_session');
    assert.equal(resume?.sessionPath, fixture.sessionPath);
    assert.ok(!readCommands(child).some((command) => command.type === 'prompt'));

    feedStdoutLines(child, [{
      type: 'response', id: resume?.id, command: 'switch_session', success: true,
      data: { cancelled: false },
    }]);
    assert.equal(readCommands(child)[0]?.type, 'prompt');
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession does not prompt when Pi rejects switch_session', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: (channel, payload) => events.push({ channel, ...payload }),
    });
    const [resume] = readCommands(child);
    feedStdoutLines(child, [{
      type: 'response', id: resume?.id, command: 'switch_session', success: false,
      error: 'rejected',
    }]);

    assert.equal(readCommands(child).length, 0);
    assert.equal(session.hasFatalError(), true);
    assert.equal(events.find((event) => event.channel === 'error')?.code, 'PI_RESUME_SESSION_FAILED');
  } finally {
    await fixture.cleanup();
  }
});

test.each([
  ['missing', (fixture: Awaited<ReturnType<typeof createPiSessionFixture>>) => path.join(fixture.root, 'missing.jsonl')],
  ['outside its owner root', (fixture: Awaited<ReturnType<typeof createPiSessionFixture>>) => fixture.sessionPath],
  ['with a mismatched cwd', (fixture: Awaited<ReturnType<typeof createPiSessionFixture>>) => fixture.sessionPath],
] as const)('attachPiRpcSession rejects a %s resume session before prompt', async (name, selectPath) => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const allowedRoot = name === 'outside its owner root'
    ? await fsp.mkdtemp(path.join((await import('node:os')).tmpdir(), 'pi-rpc-other-root-'))
    : fixture.root;
  const expectedCwd = name === 'with a mismatched cwd' ? path.join(fixture.root, 'other-project') : fixture.cwd;
  if (name === 'with a mismatched cwd') await fsp.mkdir(expectedCwd);
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: expectedCwd,
      resumeSession: { path: selectPath(fixture), root: allowedRoot },
      send: (channel, payload) => events.push({ channel, ...payload }),
    });

    assert.equal(readCommands(child).length, 0);
    assert.equal(session.hasFatalError(), true);
    assert.equal(events.find((event) => event.channel === 'error')?.code, 'PI_RESUME_SESSION_INVALID');
    assert.equal(child.killed, true);
  } finally {
    await fixture.cleanup();
    if (allowedRoot !== fixture.root) await fsp.rm(allowedRoot, { recursive: true, force: true });
  }
});

test('attachPiRpcSession rejects a resume parent chain cycle before prompt', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    const header = JSON.parse((await fsp.readFile(fixture.sessionPath, 'utf8')).trim()) as JsonRecord;
    await fsp.writeFile(fixture.sessionPath, `${JSON.stringify({ ...header, parentSession: fixture.sessionPath })}\n`);
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: () => {},
    });
    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects a resume parent outside its owner root', async () => {
  const fixture = await createPiSessionFixture();
  const outside = await createPiSessionFixture({ cwd: fixture.cwd });
  const fsp = await import('node:fs/promises');
  try {
    const header = JSON.parse((await fsp.readFile(fixture.sessionPath, 'utf8')).trim()) as JsonRecord;
    await fsp.writeFile(fixture.sessionPath, `${JSON.stringify({
      ...header,
      parentSession: outside.sessionPath,
    })}\n`);
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: () => {},
    });
    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
    await outside.cleanup();
  }
});

test('attachPiRpcSession rejects a symlinked resume file before prompt', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const linkPath = path.join(fixture.root, 'linked.jsonl');
  try {
    await fsp.symlink(fixture.sessionPath, linkPath);
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: linkPath, root: fixture.root },
      send: () => {},
    });
    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession bounds resume header parsing before prompt', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    await fsp.writeFile(fixture.sessionPath, ' '.repeat(64 * 1024 + 1));
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: () => {},
    });
    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects malformed JSONL after a valid resume header before prompt', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    const header = (await fsp.readFile(fixture.sessionPath, 'utf8')).trim();
    await fsp.writeFile(fixture.sessionPath, `${header}\n{not-json}\n`);
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: () => {},
    });

    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects an oversized resume file before prompt', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    const handle = await fsp.open(fixture.sessionPath, 'r+');
    try {
      await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: () => {},
    });

    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession enforces the aggregate lineage budget before full-file reads', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const childPath = path.join(fixture.root, 'large-child.jsonl');
  const parentPath = path.join(fixture.root, 'large-parent.jsonl');
  const writeSparseSession = async (filePath: string, parentSession?: string) => {
    const handle = await fsp.open(filePath, 'w');
    try {
      await handle.write(`${JSON.stringify({
        type: 'session',
        cwd: fixture.cwd,
        ...(parentSession ? { parentSession } : {}),
      })}\n`);
      await handle.truncate(33 * 1024 * 1024);
    } finally {
      await handle.close();
    }
  };
  try {
    await writeSparseSession(parentPath);
    await writeSparseSession(childPath, parentPath);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: childPath, root: fixture.root },
      send: () => {},
    });

    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
    assert.equal(readSpy.mock.calls.length, 0);
  } finally {
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});

test('attachPiRpcSession bounds resume parent depth before prompt', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    const paths = Array.from({ length: 33 }, (_, index) => path.join(fixture.root, `session-${index}.jsonl`));
    for (let index = paths.length - 1; index >= 0; index -= 1) {
      await fsp.writeFile(paths[index]!, `${JSON.stringify({
        type: 'session',
        version: 3,
        id: `session-${index}`,
        timestamp: '2026-08-06T00:00:00.000Z',
        cwd: fixture.cwd,
        ...(paths[index + 1] ? { parentSession: paths[index + 1] } : {}),
      })}\n`);
    }
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'must not be sent',
      cwd: fixture.cwd,
      resumeSession: { path: paths[0]!, root: fixture.root },
      send: () => {},
    });
    assert.equal(session.hasFatalError(), true);
    assert.equal(readCommands(child).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession captures get_state only after agent_end and agent_settled', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    readCommands(child);

    feedStdoutLines(child, [{ type: 'agent_end' }]);
    assert.equal(child.stdin.writableEnded, false);
    assert.equal(readCommands(child).length, 0);

    feedStdoutLines(child, [{ type: 'agent_settled' }]);
    const [getState] = readCommands(child);
    assert.equal(getState?.type, 'get_state');
    assert.equal(child.stdin.writableEnded, false);

    feedStdoutLines(child, [{
      type: 'response', id: getState?.id, command: 'get_state', success: true,
      data: { sessionFile: fixture.sessionPath },
    }]);
    assert.equal(session.getLastSessionPath(), fixture.sessionPath);
    assert.equal(child.stdin.writableEnded, true);

    child.emit('close', 0, null);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession exposes quiescence only after validated state and child close', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    const quiescence = session.waitForQuiescence();
    let published = false;
    void quiescence.then(() => { published = true; });
    readCommands(child);

    feedStdoutLines(child, [{ type: 'agent_end' }, { type: 'agent_settled' }]);
    const [getState] = readCommands(child);
    feedStdoutLines(child, [{
      type: 'response', id: getState?.id, command: 'get_state', success: true,
      data: { sessionFile: fixture.sessionPath },
    }]);
    await Promise.resolve();
    assert.equal(published, false, 'snapshot publication must still wait for child close');

    child.emit('close', 0, null);
    await assert.doesNotReject(quiescence);
    assert.equal(published, true);
    assert.equal(session.getLastSessionPath(), fixture.sessionPath);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession treats child exit without settled get_state as fatal', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: (channel, payload) => events.push({ channel, ...payload }),
    });
    readCommands(child);
    feedStdoutLines(child, [{ type: 'agent_end' }]);
    child.emit('close', 1, null);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
    assert.equal(events.find((event) => event.channel === 'error')?.code, 'PI_SESSION_STATE_FAILED');
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession safely captures the only complete session after an unexpected exit', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const createdPath = path.join(fixture.root, 'created-after-prompt.jsonl');
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    readCommands(child);
    await fsp.writeFile(createdPath, [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'created-after-prompt',
        timestamp: '2026-08-06T00:00:00.000Z',
        cwd: fixture.cwd,
      }),
      JSON.stringify({ type: 'message', role: 'user', content: 'complete' }),
      '',
    ].join('\n'));

    child.emit('close', 1, null);

    assert.equal(session.hasFatalError(), false);
    assert.equal(session.getLastSessionPath(), createdPath);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession does not capture an unchanged resumed session after an unexpected exit', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      resumeSession: { path: fixture.sessionPath, root: fixture.root },
      send: () => {},
    });
    const [resume] = readCommands(child);
    feedStdoutLines(child, [{
      type: 'response', id: resume?.id, command: 'switch_session', success: true,
      data: { cancelled: false },
    }]);
    readCommands(child);

    child.emit('close', 1, null);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects a corrupted full JSONL session after an unexpected exit', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: (channel, payload) => events.push({ channel, ...payload }),
    });
    readCommands(child);
    await fsp.writeFile(path.join(fixture.root, 'corrupt.jsonl'), [
      JSON.stringify({ type: 'session', cwd: fixture.cwd }),
      '{not-json}',
      '',
    ].join('\n'));

    child.emit('close', 1, null);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
    assert.equal(events.find((event) => event.channel === 'error')?.code, 'PI_SESSION_STATE_FAILED');
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects ambiguous changed sessions after an unexpected exit', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const header = (id: string) => `${JSON.stringify({ type: 'session', id, cwd: fixture.cwd })}\n`;
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    readCommands(child);
    await Promise.all([
      fsp.writeFile(path.join(fixture.root, 'one.jsonl'), header('one')),
      fsp.writeFile(path.join(fixture.root, 'two.jsonl'), header('two')),
    ]);

    child.emit('close', 1, null);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects an oversized fallback session before reading it', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const oversizedPath = path.join(fixture.root, 'oversized.jsonl');
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    readCommands(child);
    const handle = await fsp.open(oversizedPath, 'w');
    try {
      await handle.write(`${JSON.stringify({ type: 'session', cwd: fixture.cwd })}\n`);
      await handle.truncate(64 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }

    child.emit('close', 1, null);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession rejects a fallback session that changes while it is read', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const createdPath = path.join(fixture.root, 'changing.jsonl');
  const originalReadFileSync = fs.readFileSync.bind(fs);
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    readCommands(child);
    await fsp.writeFile(createdPath, `${JSON.stringify({ type: 'session', cwd: fixture.cwd })}\n`);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((filePath: fs.PathOrFileDescriptor) => {
      const contents = originalReadFileSync(filePath);
      if (path.resolve(String(filePath)) === createdPath) fs.appendFileSync(createdPath, '{}\n');
      return contents;
    }) as typeof fs.readFileSync);

    child.emit('close', 1, null);
    readSpy.mockRestore();

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
  } finally {
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});

test('attachPiRpcSession captures a complete session from the bounded cancel exit fallback', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  const createdPath = path.join(fixture.root, 'cancelled.jsonl');
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: (channel, payload) => events.push({ channel, ...payload }),
    });
    readCommands(child);
    session.abort();
    readCommands(child);
    await fsp.writeFile(createdPath, [
      JSON.stringify({ type: 'session', id: 'cancelled', cwd: fixture.cwd }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'partial-safe-state' }),
      '',
    ].join('\n'));
    child.emit('close', null, 'SIGTERM');

    assert.equal(session.hasFatalError(), false);
    assert.equal(session.getLastSessionPath(), createdPath);
    assert.ok(!events.some((event) => event.channel === 'error'));
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession abort escalates from SIGTERM to SIGKILL when Pi stays alive', async () => {
  vi.useFakeTimers();
  const previousGrace = process.env.PI_GRACEFUL_SHUTDOWN_MS;
  process.env.PI_GRACEFUL_SHUTDOWN_MS = '100';
  try {
    const child = createMockChild({ closeOn: 'SIGKILL' });
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: process.cwd(),
      send: () => {},
    });
    readCommands(child);

    session.abort();
    await vi.advanceTimersByTimeAsync(2_000);

    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    if (previousGrace === undefined) delete process.env.PI_GRACEFUL_SHUTDOWN_MS;
    else process.env.PI_GRACEFUL_SHUTDOWN_MS = previousGrace;
    vi.useRealTimers();
  }
});

test('attachPiRpcSession rejects get_state session files outside the owned root', async () => {
  const fixture = await createPiSessionFixture();
  const outside = await createPiSessionFixture({ cwd: fixture.cwd });
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: (channel, payload) => events.push({ channel, ...payload }),
    });
    readCommands(child);
    feedStdoutLines(child, [{ type: 'agent_end' }, { type: 'agent_settled' }]);
    const [getState] = readCommands(child);
    feedStdoutLines(child, [{
      type: 'response', id: getState?.id, command: 'get_state', success: true,
      data: { sessionFile: outside.sessionPath },
    }]);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
    assert.equal(events.find((event) => event.channel === 'error')?.code, 'PI_SESSION_STATE_FAILED');
  } finally {
    await fixture.cleanup();
    await outside.cleanup();
  }
});

test('attachPiRpcSession rejects malformed JSONL returned by get_state', async () => {
  const fixture = await createPiSessionFixture();
  const fsp = await import('node:fs/promises');
  try {
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: () => {},
    });
    readCommands(child);
    await fsp.appendFile(fixture.sessionPath, '{not-json}\n');
    feedStdoutLines(child, [{ type: 'agent_end' }, { type: 'agent_settled' }]);
    const [getState] = readCommands(child);
    feedStdoutLines(child, [{
      type: 'response', id: getState?.id, command: 'get_state', success: true,
      data: { sessionFile: fixture.sessionPath },
    }]);

    assert.equal(session.hasFatalError(), true);
    assert.equal(session.getLastSessionPath(), null);
  } finally {
    await fixture.cleanup();
  }
});

test('attachPiRpcSession keeps state parsing after abort while suppressing user events', async () => {
  const fixture = await createPiSessionFixture();
  try {
    const events: TestSentEvent[] = [];
    const child = createMockChild();
    const session = attachPiRpcSession({
      child: child as unknown as ChildProcess,
      prompt: 'turn',
      cwd: fixture.cwd,
      sessionDir: fixture.root,
      send: (channel, payload) => events.push({ channel, ...payload }),
    });
    readCommands(child);
    session.abort();
    assert.equal(readCommands(child)[0]?.type, 'abort');

    feedStdoutLines(child, [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hidden' } },
      { type: 'agent_end' },
      { type: 'agent_settled' },
    ]);
    const [getState] = readCommands(child);
    assert.equal(getState?.type, 'get_state');
    feedStdoutLines(child, [{
      type: 'response', id: getState?.id, command: 'get_state', success: true,
      data: { sessionFile: fixture.sessionPath },
    }]);

    assert.ok(!events.some((event) => event.delta === 'hidden'));
    assert.equal(session.getLastSessionPath(), fixture.sessionPath);
    assert.equal(child.stdin.writableEnded, true);
    child.emit('close', 0, null);
  } finally {
    await fixture.cleanup();
  }
});
