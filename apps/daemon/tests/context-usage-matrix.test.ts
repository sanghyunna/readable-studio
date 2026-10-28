import { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamHandler } from '../src/claude-stream.js';
import { contextUsageAtRunEnd, contextUsageStartReason, makeUnknownContextUsage, selectContextUsage } from '../src/context-usage.js';
import { createCopilotStreamHandler } from '../src/copilot-stream.js';
import { createJsonEventStreamHandler } from '../src/json-event-stream.js';
import { attachPiRpcSession } from '../src/pi-rpc.js';
import { createQoderStreamHandler } from '../src/qoder-stream.js';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';
import { AGENT_DEFS } from '../src/runtimes/registry.js';
import type { RuntimeAgentDef } from '../src/runtimes/types.js';
import { daemonAgentPayloadToPersistedAgentEvent } from '../src/server.js';

type Event = Record<string, unknown>;
const TRANSIENT = ['run-started', 'compacting', 'compacted', 'model-changed'];
// Stream formats whose adapter emits context_usage; everything else can only ever be not-reported.
const PRODUCERS = new Set(['pi-rpc', 'codex-app-server']);
const fixture = (name: string) => readFileSync(new URL(`../../../mocks/fixtures/${name}`, import.meta.url), 'utf8');
const lines = (...frames: unknown[]) => frames.map(frame => `${JSON.stringify(frame)}\n`).join('');
const stdioChild = () => Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  kill: () => true });

/** Each stream format through its production adapter: recorded fixtures where they exist, empty streams otherwise. */
async function replay(def: RuntimeAgentDef): Promise<Event[]> {
  const events: Event[] = [];
  const push = (event: Event) => { events.push(event); };
  switch (def.streamFormat) {
    case 'json-event-stream': {
      const parser = createJsonEventStreamHandler(def.eventParser || def.id, push);
      parser.feed(def.id === 'cursor-agent' ? fixture('cursor-agent/thinking-tool-segments.jsonl') : '');
      parser.flush();
      break;
    }
    case 'claude-stream-json': { const parser = createClaudeStreamHandler(push); parser.feed(''); parser.flush(); break; }
    case 'qoder-stream-json': { const parser = createQoderStreamHandler(push); parser.feed(''); parser.flush(); break; }
    case 'copilot-stream-json': { const parser = createCopilotStreamHandler(push); parser.feed(''); parser.flush(); break; }
    case 'pi-rpc': {
      // A failed turn never requests occupancy, so the run-start marker is the last word.
      const child = stdioChild();
      attachPiRpcSession({ child, prompt: 'fixture', cwd: process.cwd(), model: 'fixture-model', send: (_channel, event) => push(event) });
      child.stdout.write(lines({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'fixture failure' } },
        { type: 'turn_end', message: { stopReason: 'error' } }, { type: 'agent_end' }, { type: 'agent_settled' }));
      await new Promise(resolve => setImmediate(resolve));
      child.emit('close', 1, null);
      break;
    }
    case 'codex-app-server': {
      // The recorded occupancy, then a compaction with no later measurement.
      const child = stdioChild();
      attachCodexAppServerSession({ child, cwd: process.cwd(), model: 'fixture-model', prompt: 'fixture', onEvent: push });
      child.stdout.write(lines({ id: 1, result: {} }, { id: 2, result: { thread: { id: 'thread' } } }, { id: 3, result: { turn: { id: 'turn' } } }));
      child.stdout.write(fixture('context-usage/codex-app-server.jsonl'));
      child.stdout.write(lines({ method: 'thread/compacted', params: { threadId: 'thread' } },
        { method: 'turn/completed', params: { turn: { status: 'completed' } } }));
      await new Promise(resolve => setImmediate(resolve));
      child.emit('close', 0, null);
      break;
    }
    default: break; // plain and acp-json-rpc have no occupancy producer.
  }
  return events;
}

describe.each(AGENT_DEFS.map(def => [def.id, def] as const))('%s context occupancy', (_id, def) => {
  it('never persists a transient end state after a run', async () => {
    const produced = await replay(def);
    // server.ts's chat run: the start marker, the adapter's events, then the child-close rule for the last reason.
    // That wiring itself is pinned end to end by context-usage-run-end.test.ts and run-event-batching.test.ts.
    const start = { type: 'context_usage', snapshot: makeUnknownContextUsage(contextUsageStartReason(def.streamFormat), 'fixture-model', null, 1) };
    const emitted = [start, ...produced];
    const last = emitted.filter(event => event.type === 'context_usage').at(-1) as { snapshot: { reason?: string } };
    const end = contextUsageAtRunEnd(last.snapshot.reason, 'fixture-model');
    // Pi's failed turn and Codex's trailing compaction leave a waiting marker that only the close rule can end.
    expect(end !== null).toBe(PRODUCERS.has(def.streamFormat));
    const agentEvents = end ? [...emitted, { type: 'context_usage', snapshot: end }] : emitted;
    const persisted = { id: 'r', agentId: def.id, createdAt: 1,
      events: agentEvents.map(event => daemonAgentPayloadToPersistedAgentEvent(event)).filter(Boolean) };
    const reasons = persisted.events.flatMap(event => event?.kind === 'context_usage' ? [event.snapshot?.reason] : []);
    expect(reasons.at(-1)).toBe('not-reported');
    // The selector is a second, independent guard for rows written before this rule existed.
    const select = (runs: Parameters<typeof selectContextUsage>[0]['runs'], restored = persisted) => selectContextUsage({
      projectId: 'p', conversationId: 'c', agentId: def.id, model: 'fixture-model', persisted: restored, runs, now: 2 }).snapshot;
    // Restored after a daemon restart: only the persisted message row remains.
    expect(TRANSIENT).not.toContain(select([]).reason);
    for (const status of ['succeeded', 'failed', 'canceled']) {
      const live = { ...persisted, status, events: agentEvents.map(data => ({ event: 'agent', data })) };
      expect(TRANSIENT).not.toContain(select([live], { ...persisted, events: [] }).reason);
    }
    if (!PRODUCERS.has(def.streamFormat)) {
      // A runtime without a producer must not show "refreshing" while it runs either.
      expect(produced.filter(event => event.type === 'context_usage')).toEqual([]);
      const running = { ...persisted, status: 'running', events: agentEvents.map(data => ({ event: 'agent', data })) };
      expect(select([running], { ...persisted, events: [] })).toMatchObject({ state: 'unknown', reason: 'not-reported' });
    }
  });
});
