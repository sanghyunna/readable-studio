import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createClaudeStreamHandler } from '../src/claude-stream.js';
import { attachAcpSession } from '../src/acp.js';
import { attachCodexAppServerSession } from '../src/runtimes/codex-app-server.js';
import { createChatRunService } from '../src/runs.js';
import { createCopilotStreamHandler } from '../src/copilot-stream.js';
import { createQoderStreamHandler } from '../src/qoder-stream.js';
import { startDatabricksPiSession } from '../src/runtimes/pi-databricks.js';
import { withDeadline } from '../src/databricks/client.js';
import { runtimeFixture, runtimeServiceFixture } from './databricks/runtime-fixture.js';
import * as storage from '../src/db.js';
import { exportProjectTranscript } from '../src/transcript-export.js';

const thought = 'REASONING_DELIVERY_SENTINEL';
const answer = 'ANSWER_DELIVERY_SENTINEL';
const sse = (frames: unknown[]) => frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');

for (const adapter of ['codex', 'acp'] as const) {
  test(`${adapter} real stdio delivers reasoning before and after assistant text`, async () => {
    const peer = `
      const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const m=JSON.parse(line);
        if(m.method==='initialize') send({id:m.id,result:{}});
        if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
        if(m.method==='session/new') send({id:m.id,result:{sessionId:'session'}});
        if(m.method==='turn/start') {
          send({id:m.id,result:{turn:{id:'turn'}}});
          send({method:'item/reasoning/summaryTextDelta',params:{itemId:'r',delta:'${thought}'}});
          send({method:'item/agentMessage/delta',params:{itemId:'a',delta:'${answer}'}});
          send({method:'item/reasoning/textDelta',params:{itemId:'r2',delta:'${thought}'}});
          send({method:'turn/completed',params:{turn:{status:'completed'}}});
        }
        if(m.method==='session/prompt') {
          for(const [sessionUpdate,text] of [['agent_thought_chunk','${thought}'],['agent_message_chunk','${answer}'],['agent_thought_chunk','${thought}']])
            send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate,content:{type:'text',text}}}});
          send({id:m.id,result:{stopReason:'end_turn'}});
        }
      }).on('close',()=>process.exit(0));`;
    const child = spawn(process.execPath, ['-e', peer], { stdio: 'pipe', windowsHide: true });
    const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) });
    const events: Record<string, unknown>[] = [];
    if (adapter === 'codex') attachCodexAppServerSession({ child, cwd: process.cwd(), prompt: 'fixture', model: 'fixture-model', onEvent: event => events.push(event) });
    else attachAcpSession({ child, cwd: process.cwd(), prompt: 'fixture', model: null, mcpServers: [], send: (_channel, event) => events.push(event as Record<string, unknown>) });
    try {
      await closed;
      expect(events.filter(event => ['thinking_delta', 'text_delta'].includes(String(event.type))))
        .toEqual([{ type: 'thinking_delta', delta: thought }, { type: 'text_delta', delta: answer }, { type: 'thinking_delta', delta: thought }]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  });
}

test('run SSE delivers reasoning with no assistant message ID and preserves before/after text ordering', () => {
  const service = createChatRunService({ createSseResponse: () => { throw new Error('unused'); }, createSseErrorPayload: () => ({}) });
  const run = service.create();
  expect(run.assistantMessageId).toBeNull();
  const sent: Record<string, unknown>[] = [];
  run.clients.add({ send: (_channel: string, payload: Record<string, unknown>) => sent.push(payload) });
  service.emit(run, 'agent', { type: 'thinking_delta', delta: thought });
  service.emit(run, 'agent', { type: 'text_delta', delta: answer });
  service.emit(run, 'agent', { type: 'thinking_delta', delta: thought });
  service.emit(run, 'agent', { type: 'usage' }); // Synchronous boundary flush, no timing luck.
  expect(sent.slice(0, 3)).toEqual([{ type: 'thinking_delta', delta: thought }, { type: 'text_delta', delta: answer }, { type: 'thinking_delta', delta: thought }]);
});

test('Claude, Copilot and Qoder wire reasoning reaches the daemon event sink before and after text', () => {
  const factories = [createClaudeStreamHandler, createCopilotStreamHandler, createQoderStreamHandler];
  const wires = [
    [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: thought }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: thought }] } },
    ],
    [
      { type: 'assistant.reasoning_delta', data: { deltaContent: thought } },
      { type: 'assistant.message_delta', data: { deltaContent: answer } },
      { type: 'assistant.reasoning_delta', data: { deltaContent: thought } },
    ],
    [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: thought }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: thought }] } },
    ],
  ];
  for (const [index, factory] of factories.entries()) {
    const events: Record<string, unknown>[] = [];
    const parser = factory(event => events.push(event));
    for (const wire of wires[index]!) parser.feed(`${JSON.stringify(wire)}\n`);
    parser.flush();
    expect(events.filter(event => ['thinking_delta', 'text_delta'].includes(String(event.type))))
      .toEqual([{ type: 'thinking_delta', delta: thought }, { type: 'text_delta', delta: answer }, { type: 'thinking_delta', delta: thought }]);
  }
});

// Real managed Pi 0.83.0 process + real local relay + real RPC parser.
// Only upstream HTTP is substituted. No provider credentials or user install.
for (const dialect of ['chat-reasoning-content', 'chat-typed-summary', 'messages-thinking', 'messages-translated',
  'responses-summary', 'responses-reasoning-text', 'responses-summary-first', 'responses-raw-first'] as const) {
  test(`Databricks ${dialect} must emit thinking_delta through managed Pi RPC`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'thinking-delivery-'));
    const runtime = runtimeFixture(dialect === 'messages-thinking' ? 'anthropic-messages' : 'openai-completions');
    if (dialect.startsWith('chat-')) runtime.baseUrl = 'https://workspace.example/serving-endpoints/reasoning-fixture/invocations';
    if (dialect === 'messages-translated') runtime.wireCapabilities = { responsesUnsupported: true,
      chatTokensField: 'max_completion_tokens', requiredOutputBudget: false, omittedFields: [] };
    const { service } = runtimeServiceFixture(runtime);
    const events: Record<string, unknown>[] = [];
    const routes: string[] = [];
    let wire: string;
    if (dialect.startsWith('responses-')) {
      const type = dialect.startsWith('responses-summary') ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta';
      const alternate = type === 'response.reasoning_text.delta' ? 'response.reasoning_summary_text.delta' : 'response.reasoning_text.delta';
      const both = dialect.endsWith('-first');
      // Given: duplicate dialects can have different chunk boundaries and arrive after prose.
      wire = sse([
        { type: 'response.created', response: { id: 'resp_reasoning', created_at: 1 } },
        { type, item_id: 'reasoning_1', output_index: 0, content_index: 0, summary_index: 0, sequence_number: 1, delta: thought.slice(0, 9) },
        ...(both ? [{ type: alternate, item_id: 'reasoning_1', output_index: 0, delta: thought }] : []),
        { type, item_id: 'reasoning_1', output_index: 0, delta: thought.slice(9) },
        { type: 'response.output_text.delta', delta: answer },
        ...(both ? [{ type: alternate, item_id: 'reasoning_1', output_index: 0, delta: 'duplicate after prose' }] : []),
        { type: both ? alternate : type, item_id: 'reasoning_2', output_index: 2, content_index: 0, summary_index: 0, sequence_number: 3, delta: thought },
        ...(both ? [{ type, item_id: 'reasoning_2', output_index: 2, delta: thought }] : []),
        { type: 'response.completed', response: { id: 'resp_reasoning', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
      ]);
    } else if (dialect.startsWith('messages-')) {
      wire = sse([
        { type: 'message_start', message: { id: 'msg_reasoning', type: 'message', role: 'assistant', model: runtime.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]);
    } else {
      const reasoning = dialect === 'chat-reasoning-content' ? { reasoning_content: thought }
        : { content: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: thought }] }] };
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'chat_reasoning', object: 'chat.completion.chunk', created: 1, model: runtime.model, choices: [{ index: 0, delta, finish_reason }] });
      wire = sse([chunk({ role: 'assistant', ...reasoning }), chunk({ content: answer }), chunk(reasoning), chunk({}, 'stop'), '[DONE]']);
    }
    const fixtureFetch: typeof fetch = async (input) => {
      routes.push(new URL(String(input)).pathname);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    };
    let turn: Awaited<ReturnType<typeof startDatabricksPiSession>> | undefined;
    try {
      const cwd = path.join(root, 'project'); await mkdir(cwd);
      turn = await startDatabricksPiSession({ dataRoot: root, cwd, sessionKey: 'reasoning-test', model: runtime.appModelId,
        reasoning: 'high', service, fetch: fixtureFetch, prompt: 'Return the fixture answer.', send: (_channel, event) => events.push(event) });
      // When: the real Pi turn consumes the relay stream.
      const completed = turn.completed;
      await withDeadline(() => completed, 20000);
      // Then: thinking remains separate from prose, once and in wire order.
      expect(turn.session.hasFatalError(), JSON.stringify(events)).toBe(false);
      expect(events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(answer);
      const reasoning = events.filter(event => event.type === 'thinking_delta').map(event => event.delta).join('');
      expect(routes).toEqual([dialect.startsWith('chat-') ? '/serving-endpoints/reasoning-fixture/invocations'
        : dialect.startsWith('messages-') ? '/ai-gateway/anthropic/v1/messages' : '/ai-gateway/openai/v1/responses']);
      expect(reasoning, `missing thinking_delta for ${dialect}; upstream reasoning was emitted, answer arrived, observed events=${JSON.stringify(events.map(event => event.type))}`)
        .toBe(dialect.startsWith('messages-') ? thought : thought + thought);
      const ordered: { type: unknown; delta: string }[] = [];
      for (const event of events) {
        if (event.type !== 'thinking_delta' && event.type !== 'text_delta') continue;
        const previous = ordered.at(-1);
        if (previous?.type === event.type) previous.delta += String(event.delta);
        else ordered.push({ type: event.type, delta: String(event.delta) });
      }
      expect(ordered).toEqual([{ type: 'thinking_delta', delta: thought }, { type: 'text_delta', delta: answer },
        ...(dialect.startsWith('messages-') ? [] : [{ type: 'thinking_delta', delta: thought }])]);
    } finally {
      if (turn) {
        if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill();
        const completed = turn.completed;
        await withDeadline(() => Promise.allSettled([completed]), 5000);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
}

test('thinking survives database reload, fork and transcript export', async () => {
  // Given: the canonical persisted thinking/text/thinking sequence.
  const root = await mkdtemp(path.join(tmpdir(), 'thinking-persistence-'));
  const events = [{ kind: 'thinking', text: thought }, { kind: 'text', text: answer }, { kind: 'thinking', text: thought }];
  try {
    const db = storage.openDatabase(root);
    storage.insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
    for (const id of ['source', 'fork']) storage.insertConversation(db, { id, projectId: 'p', createdAt: 1, updatedAt: 1 });
    storage.upsertMessage(db, 'source', { id: 'm', role: 'assistant', content: answer });
    for (const event of events) storage.appendMessageAgentEvent(db, 'm', event);
    // When: reload from disk, fork the message and export the project.
    storage.closeDatabase();
    const reopened = storage.openDatabase(root);
    storage.copyMessagePrefix(reopened, { sourceConversationId: 'source', targetConversationId: 'fork', throughPosition: 0 });
    const projectsRoot = path.join(root, 'projects');
    await mkdir(path.join(projectsRoot, 'p'), { recursive: true });
    const exported = exportProjectTranscript(reopened, projectsRoot, 'p', { now: () => new Date('2026-01-01T00:00:00Z') });
    // Then: both persisted copies and the exported thinking blocks retain order.
    expect(storage.listMessages(reopened, 'source')[0]?.events).toEqual(events);
    expect(storage.listMessages(reopened, 'fork')[0]?.events).toEqual(events);
    const transcript: unknown[] = (await readFile(exported.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const blocks = transcript.flatMap(line => typeof line === 'object' && line !== null && 'blocks' in line ? [line.blocks] : []);
    expect(blocks).toEqual(Array.from({ length: 2 }, () => [
      { type: 'thinking', thinking: thought }, { type: 'text', text: answer }, { type: 'thinking', thinking: thought },
    ]));
  } finally {
    storage.closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});
