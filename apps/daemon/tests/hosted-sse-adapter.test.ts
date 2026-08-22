import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostedEventBudget, createHostedEventJournal } from '../src/hosted-event-journal.js';
import { createHostedSseAdapter } from '../src/hosted-sse-adapter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('hosted SSE adapter', () => {
  it('binds project replay to the acquired owner, generation, and project channel', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: '1',
      ownerKey: 'owner-a',
    });
    const project = { kind: 'project' as const, projectId: 'project-1' };
    const first = journal.publish(project, 'project.updated', { revision: 1 });
    const second = journal.publish(project, 'project.updated', { revision: 2 });
    journal.publish({ kind: 'run', runId: 'run-1' }, 'run.updated', { status: 'running' });
    let releases = 0;
    let acquiredBinding: unknown;
    const adapter = createHostedSseAdapter({
      acquireWeak: (binding) => {
        acquiredBinding = binding;
        return {
          generation: 1,
          journal,
          ownerKey: 'owner-a',
          release: () => { releases += 1; },
        };
      },
    });
    const response = new FakeResponse();

    expect(adapter.openProjectStream({
      generation: 1,
      lastEventId: first.cursor,
      ownerKey: 'owner-a',
      projectId: 'project-1',
      response,
    })).toMatchObject({ kind: 'attached' });
    expect(response.writes).toEqual([
      `id: ${second.cursor}\nevent: project.updated\ndata: {"revision":2}\n\n`,
    ]);
    expect(response.headers).toEqual({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    expect(acquiredBinding).toEqual({
      channel: { kind: 'project', projectId: 'project-1' },
      generation: 1,
      ownerKey: 'owner-a',
    });

    response.emit('close');
    expect(releases).toBe(1);
    journal.dispose();
  });

  it('rejects malformed or oversized Last-Event-ID before acquiring a weak lease', () => {
    let acquisitions = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => {
        acquisitions += 1;
        return null;
      },
    });
    const base = {
      generation: 1,
      ownerKey: 'owner-a',
      projectId: 'project-1',
      response: new FakeResponse(),
    };

    expect(adapter.openProjectStream({ ...base, lastEventId: ['duplicate', 'cursor'] })).toMatchObject({
      code: 'BAD_REQUEST',
      kind: 'bad-request',
    });
    expect(adapter.openProjectStream({ ...base, lastEventId: ' cursor' })).toMatchObject({ kind: 'bad-request' });
    expect(adapter.openProjectStream({ ...base, lastEventId: 'x'.repeat(257) })).toMatchObject({ kind: 'bad-request' });
    expect(acquisitions).toBe(0);
    expect(base.response.headers).toEqual({});
  });

  it('removes SSE headers when connection admission is overloaded', () => {
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 1,
        journal: {
          attach: () => ({ code: 'HOSTED_OVERLOADED' as const, kind: 'overloaded' as const }),
        },
        ownerKey: 'owner-a',
        release() {},
      }),
    });
    const response = new FakeResponse();

    expect(adapter.openProjectStream({
      generation: 1,
      ownerKey: 'owner-a',
      projectId: 'project-1',
      response,
    })).toEqual({ code: 'HOSTED_OVERLOADED', kind: 'overloaded' });
    expect(response.headers).toEqual({});
  });

  it('releases and rejects a weak lease whose owner or generation does not match the authenticated binding', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({ budget, generation: '2', ownerKey: 'owner-b' });
    let releases = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 2,
        journal,
        ownerKey: 'owner-b',
        release: () => { releases += 1; },
      }),
    });
    const response = new FakeResponse();

    expect(adapter.openRunStream({
      generation: 1,
      ownerKey: 'owner-a',
      response,
      runId: 'run-1',
    })).toEqual({ code: 'HOSTED_RUNTIME_UNAVAILABLE', kind: 'unavailable' });
    expect(releases).toBe(1);
    expect(response.headers).toEqual({});
    expect(response.writes).toEqual([]);
    journal.dispose();
  });

  it('rejects a cursor copied from a project channel before any run event is serialized', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({ budget, generation: '1', ownerKey: 'owner-a' });
    const copied = journal.publish(
      { kind: 'project', projectId: 'project-1' },
      'project.updated',
      { secretProjectValue: 'must-not-leak' },
    );
    journal.publish({ kind: 'run', runId: 'run-1' }, 'run.updated', { status: 'running' });
    let releases = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 1,
        journal,
        ownerKey: 'owner-a',
        release: () => { releases += 1; },
      }),
    });
    const response = new FakeResponse();

    expect(adapter.openRunStream({
      generation: 1,
      lastEventId: copied.cursor,
      ownerKey: 'owner-a',
      response,
      runId: 'run-1',
    })).toEqual({ kind: 'resync', reason: 'cursor-invalid' });
    expect(response.writes).toEqual(['event: resync\ndata: {"reason":"cursor-invalid"}\n\n']);
    expect(response.writes.join('')).not.toContain('must-not-leak');
    expect(releases).toBe(1);
    journal.dispose();
  });

  it('returns explicit cursor-expired resync and releases the weak lease', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: '1',
      limits: { maxEvents: 1 },
      ownerKey: 'owner-a',
    });
    const channel = { kind: 'run' as const, runId: 'run-1' };
    const expired = journal.publish(channel, 'run.updated', { revision: 1 });
    journal.publish(channel, 'run.updated', { revision: 2 });
    let releases = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 1,
        journal,
        ownerKey: 'owner-a',
        release: () => { releases += 1; },
      }),
    });
    const response = new FakeResponse();

    expect(adapter.openRunStream({
      generation: 1,
      lastEventId: expired.cursor,
      ownerKey: 'owner-a',
      response,
      runId: 'run-1',
    })).toEqual({ kind: 'resync', reason: 'cursor-expired' });
    expect(response.writes).toEqual(['event: resync\ndata: {"reason":"cursor-expired"}\n\n']);
    expect(releases).toBe(1);
    journal.dispose();
  });

  it('flushes a silent stream, delegates heartbeat, and releases once on disconnect', () => {
    vi.useFakeTimers();
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: '1',
      limits: { heartbeatMs: 10 },
      ownerKey: 'owner-a',
    });
    let releases = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 1,
        journal,
        ownerKey: 'owner-a',
        release: () => { releases += 1; },
      }),
    });
    const response = new FakeResponse();

    expect(adapter.openProjectStream({
      generation: 1,
      ownerKey: 'owner-a',
      projectId: 'project-1',
      response,
    })).toMatchObject({ kind: 'attached' });
    expect(response.flushed).toBe(true);
    vi.advanceTimersByTime(10);
    expect(response.writes).toEqual([': keepalive\n\n']);
    response.emit('close');
    response.emit('finish');
    vi.advanceTimersByTime(100);
    expect(response.writes).toEqual([': keepalive\n\n']);
    expect(releases).toBe(1);
    expect(budget.snapshot().connections).toBe(0);
    journal.dispose();
  });

  it('releases the weak lease when the journal disconnects a slow client', () => {
    vi.useFakeTimers();
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: '1',
      limits: { heartbeatMs: 100, slowClientMs: 10 },
      ownerKey: 'owner-a',
    });
    let releases = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 1,
        journal,
        ownerKey: 'owner-a',
        release: () => { releases += 1; },
      }),
    });
    const response = new FakeResponse(false);
    const opened = adapter.openRunStream({
      generation: 1,
      ownerKey: 'owner-a',
      response,
      runId: 'run-1',
    });
    expect(opened).toMatchObject({ kind: 'attached' });
    journal.publish({ kind: 'run', runId: 'run-1' }, 'run.progress', { delta: 'hello' });
    vi.advanceTimersByTime(10);

    expect(response.writes.at(-1)).toBe('event: resync\ndata: {"reason":"slow-client"}\n\n');
    expect(response.writableEnded).toBe(true);
    expect(releases).toBe(1);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
    expect(budget.snapshot()).toMatchObject({ bufferedBytes: 0, connections: 0 });
    journal.dispose();
  });

  it('closes the journal attachment and releases the weak lease if header flush fails', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({ budget, generation: '1', ownerKey: 'owner-a' });
    let releases = 0;
    const adapter = createHostedSseAdapter({
      acquireWeak: () => ({
        generation: 1,
        journal,
        ownerKey: 'owner-a',
        release: () => { releases += 1; },
      }),
    });
    const response = new FakeResponse();
    response.flushError = new Error('socket closed during flush');

    expect(() => adapter.openRunStream({
      generation: 1,
      ownerKey: 'owner-a',
      response,
      runId: 'run-1',
    })).toThrow('socket closed during flush');
    expect(releases).toBe(1);
    expect(response.writableEnded).toBe(true);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
    expect(budget.snapshot().connections).toBe(0);
    journal.dispose();
  });
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headers: Record<string, string> = {};
  writes: string[] = [];
  flushed = false;
  flushError: Error | null = null;

  constructor(private readonly writeResult = true) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  removeHeader(name: string): void {
    delete this.headers[name];
  }

  flushHeaders(): void {
    if (this.flushError != null) throw this.flushError;
    this.flushed = true;
  }

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.writeResult;
  }

  end(): void {
    this.writableEnded = true;
    this.emit('finish');
  }
}
