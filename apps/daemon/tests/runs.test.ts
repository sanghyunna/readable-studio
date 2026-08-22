import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatRunService } from '../src/runs.js';

describe('chat run service creation', () => {
  it('generates distinct run ids by default', () => {
    const runs = createRuns();

    expect(runs.create().id).not.toBe(runs.create().id);
  });

  it('uses an explicit internal run id', () => {
    const runs = createRuns();

    expect(runs.createWithId('canonical-run-1').id).toBe('canonical-run-1');
  });

  it('rejects a duplicate explicit run id without replacing the first run', () => {
    const runs = createRuns();
    const first = runs.createWithId('canonical-run-1');

    expect(() => runs.createWithId('canonical-run-1')).toThrow(/already exists/i);
    expect(runs.get('canonical-run-1')).toBe(first);
  });

  it('does not accept an explicit id through ordinary request metadata', () => {
    const runs = createRuns();

    const run = runs.create({ id: 'request-controlled' });

    expect(run.id).not.toBe('request-controlled');
    expect(runs.get('request-controlled')).toBeNull();
  });
});

describe('chat run service shutdown', () => {
  it('disposes only its owned timers, streams, clients, and waiters', async () => {
    vi.useFakeTimers();
    try {
      const clientA = { send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() };
      const clientB = { send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() };
      const runsA = createRunsWithClient(clientA);
      const runsB = createRunsWithClient(clientB);

      const terminalA = runsA.create();
      runsA.finish(terminalA, 'succeeded', 0, null);

      const activeA = runsA.create();
      const activeB = runsB.create();
      const logStreamA = { end: vi.fn() };
      (activeA as any).eventsLogStream = logStreamA;
      runsA.emit(activeA, 'agent', { type: 'text_delta', delta: 'discard me' });
      runsB.emit(activeB, 'agent', { type: 'text_delta', delta: 'keep me' });
      runsA.stream(activeA, { get: () => null, query: {} } as never, { on: vi.fn() } as never);
      runsB.stream(activeB, { get: () => null, query: {} } as never, { on: vi.fn() } as never);
      const waiterA = runsA.wait(activeA);

      expect(vi.getTimerCount()).toBe(3);
      runsA.dispose();

      expect(runsA.get(terminalA.id)).toBeNull();
      expect(runsA.get(activeA.id)).toBeNull();
      expect(activeA.pendingDelta).toBeNull();
      expect(logStreamA.end).toHaveBeenCalledTimes(1);
      expect(clientA.end).toHaveBeenCalledTimes(1);
      await expect(waiterA).resolves.toMatchObject({ status: 'canceled' });
      expect(vi.getTimerCount()).toBe(1);

      expect(runsB.get(activeB.id)).toBe(activeB);
      expect(activeB.status).toBe('queued');
      expect(clientB.end).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(32);
      expect(activeB.events).toContainEqual(expect.objectContaining({
        event: 'agent',
        data: { type: 'text_delta', delta: 'keep me' },
      }));

      runsB.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains structured error details on failed run status bodies', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });

    const wait = runs.wait(run);
    runs.emit(run, 'error', {
      message: 'Agent stalled without emitting any new output for 1s.',
      error: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'Agent stalled without emitting any new output for 1s.',
        retryable: true,
      },
    });
    runs.finish(run, 'failed', 1, null);

    expect(runs.statusBody(run)).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_EXECUTION_FAILED',
      error: 'Agent stalled without emitting any new output for 1s.',
    });
    await expect(wait).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_EXECUTION_FAILED',
      error: 'Agent stalled without emitting any new output for 1s.',
    });
  });



  it('ignores subsequent finish attempts after the run reaches a terminal state', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });

    const wait = runs.wait(run);
    runs.finish(run, 'succeeded', 0, null);
    runs.finish(run, 'failed', 1, 'SIGTERM');

    expect(run.status).toBe('succeeded');
    expect(run.exitCode).toBe(0);
    expect(run.signal).toBeNull();
    expect(run.events.filter((event: { event: string }) => event.event === 'end')).toHaveLength(1);
    await expect(wait).resolves.toMatchObject({ status: 'succeeded', exitCode: 0, signal: null });
  });
  it('filters active runs by conversation within the same project', () => {
    const runs = createRuns();
    const runA = runs.create({ projectId: 'project-1', conversationId: 'conv-a' });
    const runB = runs.create({ projectId: 'project-1', conversationId: 'conv-b' });
    runA.status = 'running';
    runB.status = 'running';

    expect(
      runs.list({ projectId: 'project-1', conversationId: 'conv-b', status: 'active' }),
    ).toEqual([runB]);
  });
  it('does not report a running run with an already exited child as active', () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-stale' });
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    child.exitCode = 1;
    run.status = 'running';
    (run as any).child = child;

    expect(
      runs.list({ projectId: 'project-1', conversationId: 'conv-stale', status: 'active' }),
    ).toEqual([]);
    expect(run.status).toBe('failed');
  });
  it('cancels a queued run immediately without waiting for child process shutdown', async () => {
    const runs = createRuns();
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-queued' });

    const wait = runs.wait(run);
    runs.cancel(run);

    expect(run.status).toBe('canceled');
    expect(run.cancelRequested).toBe(true);
    expect(run.signal).toBe('SIGTERM');
    expect(run.events.at(-1)).toMatchObject({
      event: 'end',
      data: { status: 'canceled', signal: 'SIGTERM' },
    });
    await expect(wait).resolves.toMatchObject({
      status: 'canceled',
      signal: 'SIGTERM',
    });
  });

  it('cancels and waits for the child exit within a bounded deadline', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;

    await expect(runs.cancelAndWait(run, { timeoutMs: 10 })).resolves.toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('reports a child that ignores cancellation instead of permitting mutation', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'never' as any });
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;

    await expect(runs.cancelAndWait(run, { timeoutMs: 1 })).resolves.toBe(false);
    expect(child.signals).toEqual(['SIGTERM']);
  });



  it('stores a run-scoped tool bundle and returns a redacted status summary', () => {
    const runs = createRuns();
    const run = runs.create({
      projectId: 'project-1',
      conversationId: 'conv-a',
      toolBundle: {
        mcpServers: [
          {
            id: 'run-tools',
            transport: 'stdio',
            command: 'node',
            args: ['server.js', '--token=secret'],
            env: { API_TOKEN: 'secret' },
          },
        ],
      },
    }) as any;

    expect(run.toolBundle.mcpServers).toHaveLength(1);
    expect(run.toolBundle.mcpServers[0]).toMatchObject({
      id: 'run-tools',
      command: 'node',
      env: { API_TOKEN: 'secret' },
    });

    const status = runs.statusBody(run);
    expect(status.toolBundle).toEqual({
      mcpServers: [
        {
          id: 'run-tools',
          transport: 'stdio',
          enabled: true,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(JSON.stringify(status)).not.toContain('server.js');
  });

  it('cancels active runs and terminates their child process during daemon shutdown', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const run = runs.create({ projectId: 'project-1', conversationId: 'conv-1' });
    run.status = 'running';
    (run as any).child = child;

    const wait = runs.wait(run);
    await runs.shutdownActive({ graceMs: 10 });

    expect(child.signals).toEqual(['SIGTERM']);
    expect(run.status).toBe('canceled');
    expect(run.cancelRequested).toBe(true);
    expect(run.signal).toBe('SIGTERM');
    await expect(wait).resolves.toMatchObject({ status: 'canceled', signal: 'SIGTERM' });
    expect(run.events.at(-1)).toMatchObject({
      event: 'end',
      data: { status: 'canceled', signal: 'SIGTERM' },
    });
  });

  it('escalates to SIGKILL when a child ignores the shutdown SIGTERM grace window', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGKILL' });
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;

    await runs.shutdownActive({ graceMs: 1 });

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(run.status).toBe('canceled');
  });

  it('uses adapter abort before process signals for ACP-style runs', async () => {
    const runs = createRuns();
    const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
    const abort = vi.fn();
    const run = runs.create();
    run.status = 'running';
    (run as any).child = child;
    (run as any).acpSession = { abort };

    await runs.shutdownActive({ graceMs: 10 });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(run.status).toBe('canceled');
  });

  it('does not add a second shutdown timer when the adapter owns abort escalation', async () => {
    vi.useFakeTimers();
    const previousGrace = process.env.PI_ABORT_GRACE_MS;
    process.env.PI_ABORT_GRACE_MS = '1';
    try {
      const runs = createRuns();
      const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
      const abort = vi.fn();
      const run = runs.create();
      run.status = 'running';
      (run as any).child = child;
      (run as any).acpSession = { abort, ownsAbortLifecycle: true };

      runs.cancel(run);
      await vi.advanceTimersByTimeAsync(10);

      expect(abort).toHaveBeenCalledTimes(1);
      expect(child.signals).toEqual([]);
    } finally {
      if (previousGrace === undefined) delete process.env.PI_ABORT_GRACE_MS;
      else process.env.PI_ABORT_GRACE_MS = previousGrace;
      vi.useRealTimers();
    }
  });

  it('cancels an ACP fallback signal when its run service is disposed', async () => {
    vi.useFakeTimers();
    const previousGrace = process.env.PI_ABORT_GRACE_MS;
    process.env.PI_ABORT_GRACE_MS = '10';
    try {
      const runs = createRuns();
      const child = new FakeChildProcess({ closeOn: 'SIGTERM' });
      const run = runs.create();
      run.status = 'running';
      (run as any).child = child;
      (run as any).acpSession = { abort: vi.fn() };

      runs.cancel(run);
      expect(vi.getTimerCount()).toBe(1);

      runs.dispose();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(20);
      expect(child.signals).toEqual([]);
    } finally {
      if (previousGrace === undefined) delete process.env.PI_ABORT_GRACE_MS;
      else process.env.PI_ABORT_GRACE_MS = previousGrace;
      vi.useRealTimers();
    }
  });
});

describe('chat run service stream replay', () => {
  it('always replays the final event when a reattaching client cursor is at the end of a terminal run', () => {
    const sendCalls: Array<{ event: string; data: unknown; id: number }> = [];
    const endCalls: number[] = [];
    const runs = createChatRunService({
      createSseResponse: () => ({
        send: vi.fn((event: string, data: unknown, id: number) => {
          sendCalls.push({ event, data, id });
          return true;
        }),
        end: vi.fn(() => endCalls.push(1)),
        cleanup: vi.fn(),
      }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
    });

    const run = runs.create({ projectId: 'p', conversationId: 'c' }) as any;
    runs.emit(run, 'stdout', { text: 'hello' });
    runs.finish(run, 'succeeded', 0, null);

    const finalEventId = run.events.at(-1).id;
    const fakeReq = {
      get: () => null,
      query: { after: String(finalEventId) },
    } as never;
    const fakeRes = { on: () => {} } as never;

    sendCalls.length = 0;
    runs.stream(run, fakeReq, fakeRes);

    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    expect(sendCalls.at(-1)?.event).toBe('end');
    expect(endCalls.length).toBe(1);
  });

  it('does not duplicate events when the cursor sits before the final event', () => {
    const sendCalls: Array<{ event: string; data: unknown; id: number }> = [];
    const runs = createChatRunService({
      createSseResponse: () => ({
        send: vi.fn((event: string, data: unknown, id: number) => {
          sendCalls.push({ event, data, id });
          return true;
        }),
        end: vi.fn(),
        cleanup: vi.fn(),
      }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs: 60_000,
    });

    const run = runs.create() as any;
    runs.emit(run, 'stdout', { text: 'a' });
    runs.emit(run, 'stdout', { text: 'b' });
    runs.finish(run, 'succeeded', 0, null);

    const cursor = run.events[0].id;
    runs.stream(
      run,
      { get: () => null, query: { after: String(cursor) } } as never,
      { on: () => {} } as never,
    );

    expect(sendCalls.map((c) => c.id)).toEqual(
      run.events.filter((e: { id: number }) => e.id > cursor).map((e: { id: number }) => e.id),
    );
  });
});

function createRuns() {
  return createChatRunService({
    createSseResponse: () => ({
      send: vi.fn(() => true),
      end: vi.fn(),
      cleanup: vi.fn(),
    }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    shutdownGraceMs: 10,
    ttlMs: 60_000,
  });
}

function createRunsWithClient(client: {
  send: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
}) {
  return createChatRunService({
    createSseResponse: () => client,
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    shutdownGraceMs: 10,
    ttlMs: 60_000,
  });
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  signals: string[] = [];

  constructor(private readonly options: { closeOn: 'SIGTERM' | 'SIGKILL' }) {
    super();
  }

  kill(signal: string): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (signal === this.options.closeOn) {
      this.signalCode = signal;
      queueMicrotask(() => {
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
      });
    }
    return true;
  }
}

// Persist every SSE event the daemon emits to a per-run JSONL file at
// <runsLogDir>/<runId>/events.jsonl. The path is surfaced on statusBody
// as `eventsLogPath`, which is what the MCP `get_run` tool returns to
// the external coding agent — so Codex / Cursor / Zed can `tail` the
// file in their own shell during a long-running Readable Studio generation, instead
// of cancelling the run because polling shows nothing changing.
describe('run event log persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-runs-log-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function createRunsWithLog(runsLogDir: string | null, ttlMs = 60_000) {
    return createChatRunService({
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
      shutdownGraceMs: 10,
      ttlMs,
      // runs.ts is `// @ts-nocheck`, so the inferred type for the
      // `runsLogDir = null` default narrows to literal `null` from the
      // outside; cast to bypass and pass the real string. Production
      // callers (server.ts) use a string path directly.
      runsLogDir: runsLogDir as unknown as null,
    });
  }

  it('batches adjacent agent deltas in the JSONL run log', async () => {
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    runs.emit(run, 'agent', { type: 'text_delta', delta: 'hello' });
    runs.emit(run, 'agent', { type: 'text_delta', delta: ' world' });
    runs.finish(run, 'succeeded', 0, null);

    // Wait for the write stream to fully flush to disk. The stream is
    // buffered through libuv; .end() is async and only resolves once
    // the kernel has accepted everything. Poll for the expected line
    // count with a short cap to keep the test snappy.
    const logPath = path.join(tmpDir, run.id, 'events.jsonl');
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(logPath)) {
        const text = fs.readFileSync(logPath, 'utf8').trim();
        lines = text ? text.split('\n') : [];
        if (lines.length >= 2) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(logPath)).toBe(true);
    expect(lines.length).toBe(2); // batched agent delta + end
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ event: 'agent', data: { type: 'text_delta', delta: 'hello world' } });
    expect(parsed[1]).toMatchObject({ event: 'end', data: { status: 'succeeded' } });
  });

  it('does not batch adjacent agent deltas with different metadata', async () => {
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    runs.emit(run, 'agent', { type: 'text_delta', blockId: 'one', delta: 'hello' });
    runs.emit(run, 'agent', { type: 'text_delta', blockId: 'two', delta: ' world' });
    runs.finish(run, 'succeeded', 0, null);

    const logPath = path.join(tmpDir, run.id, 'events.jsonl');
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(logPath)) {
        const text = fs.readFileSync(logPath, 'utf8').trim();
        lines = text ? text.split('\n') : [];
        if (lines.length >= 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ event: 'agent', data: { type: 'text_delta', blockId: 'one', delta: 'hello' } });
    expect(parsed[1]).toMatchObject({ event: 'agent', data: { type: 'text_delta', blockId: 'two', delta: ' world' } });
    expect(parsed[2]).toMatchObject({ event: 'end', data: { status: 'succeeded' } });
  });

  it('exposes eventsLogPath on statusBody when runsLogDir is configured', () => {
    const runs = createRunsWithLog(tmpDir);
    const run = runs.create({ projectId: 'p1' });

    const body = runs.statusBody(run);
    expect(body.eventsLogPath).toBe(path.join(tmpDir, run.id, 'events.jsonl'));
  });

  it('rejects path-bearing or Windows-aliased explicit ids before creating a log path', () => {
    const runs = createRunsWithLog(tmpDir);

    for (const id of [
      '../../escape',
      '..\\..\\escape',
      '.',
      '..',
      'C:\\escape',
      'con',
      'nul',
      'run-a.',
    ]) {
      expect(() => runs.createWithId(id)).toThrow(/run id is invalid/i);
    }
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('requires canonical lowercase explicit ids on case-insensitive filesystems', () => {
    const runs = createRunsWithLog(tmpDir);

    expect(() => runs.createWithId('Run-A')).toThrow(/run id is invalid/i);
    const run = runs.createWithId('run-a');
    runs.emit(run, 'start', { status: 'running' });
    runs.finish(run, 'succeeded', 0, null);

    expect(fs.readdirSync(tmpDir)).toEqual(['run-a']);
  });

  it('does not let ordinary request metadata select or reuse a run log', () => {
    const runs = createRunsWithLog(tmpDir);
    const first = runs.create({ id: 'request-controlled' });
    const second = runs.create({ id: 'request-controlled' });

    for (const run of [first, second]) {
      runs.emit(run, 'start', { status: 'running' });
      runs.finish(run, 'succeeded', 0, null);
    }

    expect(first.id).not.toBe(second.id);
    expect(fs.readdirSync(tmpDir).sort()).toEqual([first.id, second.id].sort());
  });

  it('reports eventsLogPath: null when runsLogDir is not configured (back-compat)', () => {
    const runs = createRunsWithLog(null);
    const run = runs.create({ projectId: 'p1' });

    const body = runs.statusBody(run);
    expect(body.eventsLogPath).toBeNull();
  });

  it('does not touch the filesystem when runsLogDir is not configured', () => {
    const runs = createRunsWithLog(null);
    const run = runs.create({ projectId: 'p1' });
    runs.emit(run, 'agent', { type: 'text_delta', delta: 'x' });
    runs.finish(run, 'succeeded', 0, null);

    // The tmpDir we'd otherwise have written under stays empty
    // because we configured runsLogDir=null.
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('removes only the expired terminal run log directory at TTL cleanup', async () => {
    vi.useFakeTimers();
    try {
      const runs = createRunsWithLog(tmpDir, 25);
      const expired = runs.createWithId('expired-run');
      const active = runs.createWithId('active-run');
      runs.emit(expired, 'start', { status: 'running' });
      runs.emit(active, 'start', { status: 'running' });
      runs.finish(expired, 'succeeded', 0, null);

      const closing = expired.eventsLogClosePromise as Promise<void> | null;
      if (closing) await closing;
      expect(fs.existsSync(path.join(tmpDir, 'expired-run', 'events.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'active-run', 'events.jsonl'))).toBe(true);

      await vi.advanceTimersByTimeAsync(25);

      expect(runs.get('expired-run')).toBeNull();
      expect(fs.existsSync(path.join(tmpDir, 'expired-run'))).toBe(false);
      expect(runs.get('active-run')).toBe(active);
      expect(fs.existsSync(path.join(tmpDir, 'active-run', 'events.jsonl'))).toBe(true);

      runs.dispose();
      const activeClosing = active.eventsLogClosePromise as Promise<void> | null;
      if (activeClosing) await activeClosing;
    } finally {
      vi.useRealTimers();
    }
  });
});
