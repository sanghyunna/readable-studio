import type http from 'node:http';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentCapabilities } from '../src/runtimes/capabilities.js';
import { startServer } from '../src/server.js';
import { closeHttpServer } from '../src/daemon-startup.js';
import { readMemoryConfig, writeMemoryConfig } from '../src/memory.js';
import { withFakeAgent } from './helpers/fake-agent.js';
import { readWalCommits } from './helpers/wal-commits.js';

const FILLER = 120;
const fillers = Array.from({ length: FILLER }, (_, i) => ` t${i}`);

describe('run event persistence per stdout chunk', () => {
  let server: http.Server;
  let baseUrl: string;
  let originalMemoryConfig: Awaited<ReturnType<typeof readMemoryConfig>> | null = null;

  beforeAll(async () => {
    originalMemoryConfig = await readMemoryConfig(process.env.READABLE_DATA_DIR!);
    await writeMemoryConfig(process.env.READABLE_DATA_DIR!, { enabled: false, extraction: null });
    const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    if (server) await closeHttpServer(server);
    if (originalMemoryConfig) {
      await writeMemoryConfig(process.env.READABLE_DATA_DIR!, {
        enabled: originalMemoryConfig.enabled,
        extraction: originalMemoryConfig.extraction,
      });
    }
  });

  // Runs a fake agent that writes `burst` as JSON lines in one stdout write,
  // then returns the persisted events (timestamps checked and stripped), the
  // persisted content and the WAL commits the whole run cost.
  async function runBurst(agentId: string, model: string, script: (lines: string) => string, burst: unknown[]) {
    const projectId = `proj-${randomUUID()}`;
    const assistantMessageId = `assistant-${randomUUID()}`;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Event batching fixture' }),
    });
    expect(created.ok).toBe(true);
    const { conversationId } = await created.json() as { conversationId: string };
    const messagesUrl = `${baseUrl}/api/projects/${projectId}/conversations/${conversationId}/messages`;
    const put = await fetch(`${messagesUrl}/${assistantMessageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', content: '', runStatus: 'running', events: [] }),
    });
    expect(put.ok).toBe(true);

    const dbFile = resolve(process.env.READABLE_DATA_DIR!, 'app.sqlite');
    const probe = new Database(dbFile);
    try {
      expect(probe.pragma('wal_checkpoint(TRUNCATE)')).toEqual([{ busy: 0, log: 0, checkpointed: 0 }]);
    } finally {
      probe.close();
    }

    const lines = JSON.stringify(burst.map((line) => JSON.stringify(line)).join('\n') + '\n');
    await withFakeAgent(agentId, script(lines), async () => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, model, projectId, conversationId, assistantMessageId, message: 'burst' }),
      });
      const body = await response.text();
      expect(response.ok, body).toBe(true);
      expect(body).toContain('"status":"succeeded"');
    });

    const wal = readWalCommits(dbFile);
    const listed = await (await fetch(messagesUrl)).json() as {
      messages: Array<{ id: string; content: string; events?: Array<Record<string, unknown>> }>;
    };
    const message = listed.messages.find((m) => m.id === assistantMessageId);
    const events = (message?.events ?? []).map(({ timestamp, ...event }) => {
      if (event.kind === 'text' || event.kind === 'thinking' || event.kind === 'tool_use') {
        expect(timestamp).toEqual(expect.any(Number));
      } else {
        expect(timestamp).toBeUndefined();
      }
      return event;
    });
    return { content: message?.content, events, wal };
  }

  it('persists the same rows in the same order for a json-event-stream burst delivered in one stdout write, with one commit per chunk', async () => {
    const { content, events, wal } = await runBurst('opencode', 'openai/gpt-5', (lines) => `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${lines}, () => process.exit(0));
});
`, [
      { type: 'step_start' },
      { type: 'text', part: { text: 'alpha ' } },
      // Identical consecutive deltas are deduplicated by the persistence layer today.
      { type: 'text', part: { text: 'alpha ' } },
      { type: 'tool_use', part: { tool: 'bash', callID: 'call-1', state: { status: 'completed', input: '{"command":"ls"}', output: 'listing' } } },
      { type: 'text', part: { text: 'beta' } },
      { type: 'step_start' },
      { type: 'step_start' },
      ...fillers.map((text) => ({ type: 'text', part: { text } })),
      { type: 'step_finish', part: { tokens: { input: 3, output: 4 } } },
    ]);

    // Observable rows: exactly what the per-event path persisted, in order.
    expect(content).toBe(`alpha beta${fillers.join('')}`);
    expect(events).toEqual([
      { kind: 'status', label: 'starting', detail: expect.any(String) },
      { kind: 'context_usage', snapshot: expect.objectContaining({ reason: 'not-reported' }) },
      { kind: 'status', label: 'running' },
      { kind: 'text', text: 'alpha ' },
      { kind: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls' } },
      { kind: 'tool_result', toolUseId: 'call-1', content: 'listing', isError: false },
      { kind: 'text', text: 'beta' },
      { kind: 'status', label: 'running' },
      ...fillers.map((text) => ({ kind: 'text', text })),
      { kind: 'usage', inputTokens: 3, outputTokens: 4 },
    ]);

    // Cost: the per-event path commits once per persisted delta (>= FILLER);
    // the batched path commits once per stdout chunk plus run bookkeeping.
    expect(wal.wrapped).toBe(false);
    expect(wal.commits).toBeLessThan(FILLER / 2);
  });

  it('persists the same rows in the same order for a claude stream-json burst delivered in one stdout write, with one commit per chunk', async () => {
    const text = (index: number, delta: Record<string, unknown>) =>
      ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta } });
    try {
      const { content, events, wal } = await runBurst('claude', 'sonnet', (lines) => `
if (process.argv.includes('--help')) { console.log('Usage: claude -p [--include-partial-messages] [--add-dir DIR]'); process.exit(0); }
process.stdout.write(${lines}, () => process.exit(0));
`, [
        { type: 'system', subtype: 'init', model: 'claude-fixture', session_id: 'session-1' },
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        text(0, { type: 'thinking_delta', thinking: 'hmm ' }),
        // Identical consecutive deltas are deduplicated by the persistence layer today.
        text(0, { type: 'thinking_delta', thinking: 'hmm ' }),
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} } } },
        text(1, { type: 'input_json_delta', partial_json: '{"command":"ls"}' }),
        { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'listing' }] } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } } },
        ...fillers.map((filler) => text(2, { type: 'text_delta', text: filler })),
        { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
        { type: 'assistant', message: { id: 'msg-1', stop_reason: 'end_turn', content: [
          { type: 'thinking', thinking: 'hmm hmm ' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: fillers.join('') },
        ] } },
        { type: 'result', usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.5, duration_ms: 7 },
      ]);

      expect(content).toBe(fillers.join(''));
      expect(events).toEqual([
        { kind: 'status', label: 'starting', detail: expect.any(String) },
        { kind: 'context_usage', snapshot: expect.objectContaining({ reason: 'not-reported' }) },
        { kind: 'status', label: 'initializing', detail: 'claude-fixture' },
        { kind: 'status', label: 'thinking' },
        { kind: 'thinking', text: 'hmm ' },
        { kind: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        { kind: 'tool_result', toolUseId: 'tool-1', content: 'listing', isError: false },
        ...fillers.map((filler) => ({ kind: 'text', text: filler })),
        { kind: 'usage', inputTokens: 3, outputTokens: 4, costUsd: 0.5, durationMs: 7 },
      ]);

      expect(wal.wrapped).toBe(false);
      expect(wal.commits).toBeLessThan(FILLER / 2);
    } finally {
      agentCapabilities.delete('claude');
    }
  });
});
