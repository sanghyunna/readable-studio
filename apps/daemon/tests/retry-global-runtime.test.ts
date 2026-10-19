import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeHttpServer } from '../src/daemon-startup.js';
import { startServer } from '../src/server.js';
import { listConversations, listMessages, openDatabase, upsertMessage } from '../src/db.js';
import { createChatRunService } from '../src/runs.js';
import { cleanupFakeAgentDir, writeExecutableScript } from './helpers/fake-agent.js';

const retryClock = vi.hoisted(() => ({
  delay: vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>(),
}));

const databricksPeer = vi.hoisted(() => ({
  command: '',
  directory: '',
  starts: vi.fn(),
}));

vi.mock('../src/runtimes/defs/databricks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtimes/defs/databricks.js')>();
  return {
    ...actual,
    registeredDatabricksModels: async (...args: Parameters<typeof actual.registeredDatabricksModels>) =>
      databricksPeer.command
        ? [{ id: 'db-test', label: 'Databricks test', source: 'databricks', reasoningOptions: [] }]
        : actual.registeredDatabricksModels(...args),
  };
});

vi.mock('../src/runtimes/pi-databricks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runtimes/pi-databricks.js')>();
  return {
    ...actual,
    createDatabricksPiRuntime: async (options: Parameters<typeof actual.createDatabricksPiRuntime>[0]) => {
      if (!databricksPeer.command) return actual.createDatabricksPiRuntime(options);
      databricksPeer.starts();
      return {
        invocation: {
          command: databricksPeer.command, args: [], cwd: options.cwd, env: process.env,
          agentDir: databricksPeer.directory, sessionDir: databricksPeer.directory,
        },
        close: async () => {},
      };
    },
  };
});

vi.mock('../src/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runs.js')>();
  return {
    ...actual,
    createChatRunService: (options: Parameters<typeof actual.createChatRunService>[0]) =>
      actual.createChatRunService({ ...options, retryDelay: retryClock.delay }),
  };
});

type Started = { url: string; server: Server; shutdown: () => Promise<void> };
type Event = { event: string; data: Record<string, unknown> };
type Status = {
  id: string; status: string; assistantMessageId: string; conversationId: string;
  eventsLogPath: string; error: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('global same-run retry coordinator', () => {
  let started: Started | undefined;
  let binDir: string | undefined;

  beforeEach(() => {
    retryClock.delay.mockReset().mockResolvedValue(undefined);
    databricksPeer.command = '';
    databricksPeer.starts.mockClear();
  });
  afterEach(async () => {
    await started?.shutdown();
    if (started) await closeHttpServer(started.server);
    started = undefined;
    if (binDir) await cleanupFakeAgentDir(binDir);
    binDir = undefined;
  });

  async function prepare(failures: number, failure = 'HTTP 503 Service Unavailable', visible = false, copilot = false, wrapperCode?: string, databricks = false) {
    binDir = await mkdtemp(path.join(os.tmpdir(), 'readable-global-retry-'));
    const counter = path.join(binDir, 'attempts');
    const bin = await writeExecutableScript(binDir, 'claude-global-retry', `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude-code 1.0.0'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--include-partial-messages --add-dir'); process.exit(0); }
if (process.argv.includes('__readable_capability_probe__')) { process.exit(0); }
if (process.argv[process.argv.indexOf('--output-format') + 1] === 'text') {
  console.log('{}');
  process.exit(0);
}
if (process.argv.includes('--safe-mode')) {
  console.log(JSON.stringify({ type: 'control_response', response: {
    request_id: 'models-capability-check', subtype: 'success',
    response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
  } }));
  process.exit(0);
}
process.stdin.once('data', (input) => {
  if (input.toString().includes('"type":"control_request"')) process.exit(0);
  let count = 0;
  try { count = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); } catch {}
  fs.appendFileSync(${JSON.stringify(counter + '.args')}, JSON.stringify(process.argv.slice(2)) + '\\n');
  fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1));
  if (count < ${failures}) {
    if (${databricks}) {
      process.stdout.write(JSON.stringify({ type: 'message_update',
        assistantMessageEvent: { type: 'error', reason: ${JSON.stringify(failure)} } }) + '\\n', () => process.exit(1));
      return;
    }
    if (${JSON.stringify(wrapperCode)} !== undefined) {
      const frame = {
        type: 'assistant', error: ${JSON.stringify(wrapperCode)}, parent_tool_use_id: null,
        session_id: 'error-session', uuid: 'error-frame',
        message: { id: 'error-message', type: 'message', role: 'assistant', model: '<synthetic>',
          content: ${failure ? JSON.stringify([{ type: 'text', text: failure }]) : '[]'},
          stop_reason: 'stop_sequence', stop_sequence: '',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      };
      process.stdout.write(JSON.stringify(frame) + '\\n', () => process.exit(1));
      return;
    }
    if (${copilot}) {
      process.stdout.write(JSON.stringify({ type: 'result', success: false, exitCode: 1,
        error: ${JSON.stringify(failure)}, retry_after: '12' }) + '\\n', () => process.exit(0));
      return;
    }
    const fail = () => process.stderr.write(${JSON.stringify(failure + '\n')}, () => process.exit(1));
    ${visible
      ? `process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial answer.' } } }) + '\\n', fail);`
      : 'fail();'}
  } else {
    if (${copilot}) {
      const frames = [
        { type: 'assistant.message_delta', data: { deltaContent: 'Recovered.\\n<!-- readable:no-document-required reason="question" -->' } },
        { type: 'result', success: true, exitCode: 0 }
      ];
      process.stdout.write(frames.map((frame) => JSON.stringify(frame)).join('\\n') + '\\n', () => process.exit(0));
      return;
    }
    const frame = { type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered.\\n<!-- readable:no-document-required reason="question" -->' }], stop_reason: 'end_turn' } };
    process.stdout.write(JSON.stringify(frame) + '\\n', () => process.exit(0));
  }
});
`);
    if (databricks) {
      databricksPeer.command = bin;
      databricksPeer.directory = binDir;
    }
    started = await startServer({ port: 0, returnServer: true }) as Started;
    const config = await fetch(`${started.url}/api/app-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(databricks
        ? { agentId: 'databricks', model: 'db-test' }
        : copilot
        ? { agentId: 'copilot', model: 'gpt-5.2', agentCliEnv: { copilot: { COPILOT_BIN: bin } } }
        : { agentId: 'claude', model: 'sonnet', agentCliEnv: { claude: { CLAUDE_BIN: bin } } }),
    });
    expect(config.status).toBe(200);
    return counter;
  }

  async function launch(copilot: boolean | 'databricks' = false) {
    const projectId = `retry_global_${randomUUID()}`;
    const project = await fetch(`${started!.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Retry regression',
        metadata: { kind: 'prototype' }, skipDiscoveryBrief: true }),
    });
    expect(project.status).toBe(200);
    const { conversationId } = await project.json() as { conversationId: string };
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    upsertMessage(db, conversationId, {
      id: `user_${randomUUID()}`, role: 'user', content: 'Answer a question without writing files.',
    });
    const assistantMessageId = `assistant_${randomUUID()}`;
    const response = await fetch(`${started!.url}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, conversationId, assistantMessageId,
        clientRequestId: randomUUID(),
        agentId: copilot === 'databricks' ? 'databricks' : copilot ? 'copilot' : 'claude',
        model: copilot === 'databricks' ? 'db-test' : copilot ? 'gpt-5.2' : 'sonnet',
        message: 'Answer a question without writing files.',
        currentPrompt: 'Answer a question without writing files.' }),
    });
    expect(response.status).toBe(202);
    const { runId } = await response.json() as { runId: string };
    return { runId, projectId, conversationId, assistantMessageId };
  }

  async function finish(runId: string) {
    const response = await fetch(`${started!.url}/api/runs/${runId}/events`, {
      signal: AbortSignal.timeout(15_000),
    });
    const stream = await response.text();
    expect(stream).toContain('event: end');
    const statusResponse = await fetch(`${started!.url}/api/runs/${runId}`);
    const status = await statusResponse.json() as Status;
    const events = stream.split(/\r?\n\r?\n/).flatMap((frame): Event[] => {
      const event = /^event: ?(.+)$/m.exec(frame)?.[1];
      const data = /^data: ?(.+)$/m.exec(frame)?.[1];
      return event && data ? [{ event, data: JSON.parse(data) }] : [];
    });
    return { status, events };
  }

  it('survives ten transient failures in one run with no persisted error', async () => {
    const counter = await prepare(10);
    const run = await launch();
    const { status, events } = await finish(run.runId);
    expect(status).toMatchObject({ id: run.runId, status: 'succeeded',
      assistantMessageId: run.assistantMessageId, conversationId: run.conversationId, error: null });
    expect(await readFile(counter, 'utf8'), await readFile(`${counter}.args`, 'utf8')).toBe('11');
    expect(retryClock.delay.mock.calls.map(([ms]) => ms), await readFile(`${counter}.args`, 'utf8')).toEqual(Array(10).fill(5000));
    const retrying = events.filter(({ event, data }) => event === 'agent' && data.label === 'retrying');
    expect(retrying.map(({ data }) => JSON.parse(String(data.detail)))).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        attempt: index + 1, maxRetries: 10, delayMs: 5000, agentId: 'claude',
      })),
    );
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(0);
    expect(events.filter(({ event }) => event === 'end')).toHaveLength(1);
    expect(events.filter(({ data }) => data.label === 'retry_complete')).toHaveLength(1);
    const log = await readFile(status.eventsLogPath, 'utf8');
    expect(log.split('\n').filter((line) => line && JSON.parse(line).event === 'error')).toHaveLength(0);
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    const messages = listMessages(db, run.conversationId);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(listConversations(db, run.projectId)).toHaveLength(1);
    expect(messages.find((message) => message.id === run.assistantMessageId)?.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'status', label: 'error' })]),
    );
  });

  it.each([
    ['503 text', 'API Error: 503 Service Unavailable', 'unknown'],
    ['code-only overload', '', 'overloaded_error'],
    ['code-only HTTP 529', '', '529'],
    ['code-only HTTP 429', '', '429'],
    ['code-only connection reset', '', 'ECONNRESET'],
  ])('retries a real Claude assistant error wrapper: %s', async (_label, message, code) => {
    const counter = await prepare(1, message, false, false, code);
    const run = await launch();
    const { status, events } = await finish(run.runId);
    expect(status.status, JSON.stringify(events)).toBe('succeeded');
    expect(await readFile(counter, 'utf8')).toBe('2');
    expect(retryClock.delay.mock.calls.map(([ms]) => ms)).toEqual([5000]);
    expect(events.filter(({ event, data }) => event === 'agent' && data.label === 'retrying'))
      .toEqual([expect.objectContaining({ data: expect.objectContaining({
        detail: JSON.stringify({ attempt: 1, maxRetries: 10, delayMs: 5000, agentId: 'claude' }),
      }) })]);
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(0);
    const db = openDatabase(process.cwd(), { dataDir: process.env.READABLE_DATA_DIR! });
    const saved = listMessages(db, run.conversationId).find((entry) => entry.id === run.assistantMessageId);
    expect(saved?.content).toContain('Recovered.');
    expect(saved?.content).not.toContain('API Error:');
    expect(saved?.content).not.toContain('overloaded_error');
    expect(events.filter(({ data }) => data.type === 'text_delta').map(({ data }) => data.delta).join(''))
      .not.toContain('API Error:');
  });

  it.each([
    ['Databricks [permission-denied; HTTP 403]: Access was denied. Check model permissions.', 'AGENT_EXECUTION_FAILED'],
    ['Databricks [auth; HTTP 401]: Authentication was rejected. Sign in again or replace the expired token.', 'AGENT_AUTH_REQUIRED'],
  ])('preserves terminal Databricks outer eligibility: %s', async (message, code) => {
    const counter = await prepare(11, message, false, false, undefined, true);
    const run = await launch('databricks');
    const { status, events } = await finish(run.runId);
    expect(status).toMatchObject({ status: 'failed', error: message });
    expect(databricksPeer.starts).toHaveBeenCalledTimes(1);
    expect(await readFile(counter, 'utf8')).toBe('1');
    expect(retryClock.delay).not.toHaveBeenCalled();
    expect(events.filter(({ data }) => data.label === 'retrying')).toHaveLength(0);
    expect(events.filter(({ event }) => event === 'error'), JSON.stringify(events)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({
        message, error: expect.objectContaining({ code }),
      }) }),
    ]);
  });

  it('emits exactly one final error and end after eleven failures', async () => {
    const counter = await prepare(11);
    const run = await launch();
    const { status, events } = await finish(run.runId);
    expect(status.status, await readFile(`${counter}.args`, 'utf8')).toBe('failed');
    expect(await readFile(counter, 'utf8'), await readFile(`${counter}.args`, 'utf8')).toBe('11');
    expect(retryClock.delay).toHaveBeenCalledTimes(10);
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(1);
    expect(events.filter(({ event }) => event === 'end')).toHaveLength(1);
  });

  it('does not wait or retry a fail-fast quota failure', async () => {
    const counter = await prepare(11, 'Weekly usage limit exceeded: quota exhausted');
    const run = await launch();
    const { status, events } = await finish(run.runId);
    expect(status.status).toBe('failed');
    expect(await readFile(counter, 'utf8')).toBe('1');
    expect(retryClock.delay).not.toHaveBeenCalled();
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(1);
    expect(events.filter(({ event }) => event === 'end')).toHaveLength(1);
  });

  it('cancels during the retry wait without a new spawn', async () => {
    const counter = await prepare(11);
    const waiting = deferred<AbortSignal>();
    retryClock.delay.mockImplementation((_ms, signal) => {
      waiting.resolve(signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const run = await launch();
    const completed = finish(run.runId);
    const signal = await waiting.promise;
    const cancel = await fetch(`${started!.url}/api/runs/${run.runId}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
    const { status, events } = await completed;
    expect(signal.aborted).toBe(true);
    expect(status.status).toBe('canceled');
    expect(await readFile(counter, 'utf8'), await readFile(`${counter}.args`, 'utf8')).toBe('1');
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(0);
    expect(events.filter(({ event }) => event === 'end')).toHaveLength(1);
  });

  it('does not replay an attempt after visible output', async () => {
    const counter = await prepare(11, 'HTTP 503 Service Unavailable', true);
    const run = await launch();
    const { status, events } = await finish(run.runId);
    expect(status.status).toBe('failed');
    expect(await readFile(counter, 'utf8'), await readFile(`${counter}.args`, 'utf8')).toBe('1');
    expect(retryClock.delay).not.toHaveBeenCalled();
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(1);
    expect(events.filter(({ event }) => event === 'run_retry_attempted')).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'agent', data: expect.objectContaining({ type: 'text_delta', delta: 'Partial answer.' }),
    }));
  });

  it('retries a failed Copilot result even after process exit zero and honors Retry-After', async () => {
    const counter = await prepare(1, 'HTTP 503 Service Unavailable', false, true);
    const run = await launch(true);
    const { status, events } = await finish(run.runId);
    expect(status.status).toBe('succeeded');
    expect(await readFile(counter, 'utf8')).toBe('2');
    expect(retryClock.delay.mock.calls.map(([ms]) => ms)).toEqual([12000]);
    expect(events.filter(({ event }) => event === 'error')).toHaveLength(0);
    expect(events.filter(({ event }) => event === 'end')).toHaveLength(1);
  });

  it.each(['cancel', 'shutdown'] as const)('aborts the injected wait on %s', async (operation) => {
    const service = createChatRunService({
      createSseResponse: vi.fn(),
      createSseErrorPayload: (code: string, message: string) => ({ code, message }),
    });
    const run = service.create({ agentId: 'claude' });
    const entered = deferred<AbortSignal>();
    retryClock.delay.mockImplementation((_ms, signal) => {
      entered.resolve(signal);
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const waiting = service.waitForRetry(run, 5000);
    const signal = await entered.promise;
    if (operation === 'cancel') service.cancel(run);
    else await service.shutdownActive();
    expect(await waiting).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(run.status).toBe('canceled');
    expect(run.events.filter((event: Event) => event.event === 'end')).toHaveLength(1);
    service.dispose();
  });
});
