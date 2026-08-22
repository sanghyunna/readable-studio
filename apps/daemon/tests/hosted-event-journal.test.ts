import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHostedEventBudget,
  createHostedEventJournal,
} from '../src/hosted-event-journal.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('hosted event journal', () => {
  it('binds opaque replay cursors to the owner, channel, and runtime generation', () => {
    const budget = createHostedEventBudget({
      maxEvents: 20,
      maxBytes: 20_000,
      maxConnections: 10,
      maxBufferedBytes: 20_000,
    });
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const channel = { kind: 'project' as const, projectId: 'project-1' };
    const first = journal.publish(channel, 'project.updated', { revision: 1 });
    const second = journal.publish(channel, 'project.updated', { revision: 2 });

    expect(first.cursor).not.toContain('generation-one');
    expect(first.cursor).not.toContain('owner-a');
    expect(journal.replay({ ownerKey: 'owner-a', channel, after: first.cursor })).toEqual({
      kind: 'events',
      events: [second],
    });
    expect(journal.replay({ ownerKey: 'owner-b', channel, after: first.cursor })).toEqual({
      kind: 'not-owned',
    });

    journal.dispose();
    const nextGeneration = createHostedEventJournal({
      budget,
      generation: 'generation-two',
      ownerKey: 'owner-a',
    });
    expect(nextGeneration.replay({ ownerKey: 'owner-a', channel, after: first.cursor })).toEqual({
      kind: 'resync',
      reason: 'generation-expired',
    });
    nextGeneration.dispose();
  });

  it('replays before subscribing, heartbeats only after silence, and releases connections on disconnect', () => {
    vi.useFakeTimers();
    const budget = createHostedEventBudget({
      maxEvents: 20,
      maxBytes: 20_000,
      maxConnections: 10,
      maxBufferedBytes: 20_000,
    });
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      limits: { heartbeatMs: 25, slowClientMs: 10 },
      ownerKey: 'owner-a',
    });
    const channel = { kind: 'run' as const, runId: 'run-1' };
    const first = journal.publish(channel, 'run.created', { status: 'queued' });
    const response = new FakeResponse();

    expect(journal.attach({ ownerKey: 'owner-a', channel, response })).toMatchObject({ kind: 'attached' });
    expect(response.writes).toEqual([
      `id: ${first.cursor}\nevent: run.created\ndata: {"status":"queued"}\n\n`,
    ]);
    expect(budget.snapshot().connections).toBe(1);

    vi.advanceTimersByTime(24);
    expect(response.writes).toHaveLength(1);
    journal.publish(channel, 'run.started', { status: 'running' });
    vi.advanceTimersByTime(24);
    expect(response.writes.at(-1)).toContain('event: run.started');
    vi.advanceTimersByTime(1);
    expect(response.writes.at(-1)).toBe(': keepalive\n\n');

    response.emit('close');
    expect(budget.snapshot().connections).toBe(0);
    journal.publish(channel, 'run.finished', { status: 'succeeded' });
    expect(response.writes.at(-1)).toBe(': keepalive\n\n');
    journal.dispose();
  });

  it('ends live and replayed streams after their run channel closes', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const channel = { kind: 'run' as const, runId: 'run-1' };
    const live = new FakeResponse();
    journal.attach({ ownerKey: 'owner-a', channel, response: live });
    journal.publish(channel, 'run.finished', { status: 'succeeded' });

    journal.close(channel);

    expect(live.writableEnded).toBe(true);
    expect(budget.snapshot().connections).toBe(0);
    const replay = new FakeResponse();
    journal.attach({ ownerKey: 'owner-a', channel, response: replay });
    expect(replay.writes.at(-1)).toContain('event: run.finished');
    expect(replay.writableEnded).toBe(true);
    expect(budget.snapshot().connections).toBe(0);
    journal.dispose();
  });

  it('retires channel tombstones with evicted history without reviving expired cursors', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      limits: { maxEvents: 1 },
      ownerKey: 'owner-a',
    });
    const closedRun = { kind: 'run' as const, runId: 'run-1' };
    const invalidatedProject = { kind: 'project' as const, projectId: 'project-1' };
    const runEvent = journal.publish(closedRun, 'run.finished', { status: 'succeeded' });
    journal.close(closedRun);
    const projectEvent = journal.publish(invalidatedProject, 'project.updated', { revision: 1 });
    journal.invalidate(invalidatedProject);
    journal.publish({ kind: 'owner' }, 'owner.updated', { revision: 2 });

    expect(journal.replay({ ownerKey: 'owner-a', channel: closedRun, after: runEvent.cursor })).toEqual({
      kind: 'resync',
      reason: 'cursor-expired',
    });
    expect(journal.replay({
      ownerKey: 'owner-a',
      channel: invalidatedProject,
      after: projectEvent.cursor,
    })).toEqual({
      kind: 'resync',
      reason: 'cursor-expired',
    });

    const response = new FakeResponse();
    const attached = journal.attach({ ownerKey: 'owner-a', channel: closedRun, response });
    expect(attached).toMatchObject({ kind: 'attached' });
    expect(response.writableEnded).toBe(false);
    if (attached.kind === 'attached') attached.close();
    journal.dispose();
  });

  it('returns an explicit resync event when a reconnect cursor has fallen out of the bounded journal', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      limits: { maxEvents: 2 },
      ownerKey: 'owner-a',
    });
    const channel = { kind: 'project' as const, projectId: 'project-1' };
    const expired = journal.publish(channel, 'project.updated', { revision: 1 });
    journal.publish(channel, 'project.updated', { revision: 2 });
    journal.publish(channel, 'project.updated', { revision: 3 });
    const response = new FakeResponse();

    expect(journal.attach({ ownerKey: 'owner-a', channel, after: expired.cursor, response })).toEqual({
      kind: 'resync',
      reason: 'cursor-expired',
    });
    expect(response.writes).toEqual(['event: resync\ndata: {"reason":"cursor-expired"}\n\n']);
    expect(response.writableEnded).toBe(true);
    expect(budget.snapshot().connections).toBe(0);
    journal.dispose();
  });

  it('filters owner and channel before writing to a subscriber', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const project = { kind: 'project' as const, projectId: 'project-1' };
    const wrongOwnerResponse = new FakeResponse();
    expect(journal.attach({ ownerKey: 'owner-b', channel: project, response: wrongOwnerResponse })).toEqual({
      kind: 'not-owned',
    });
    expect(wrongOwnerResponse.writes).toEqual([]);

    const projectResponse = new FakeResponse();
    expect(journal.attach({ ownerKey: 'owner-a', channel: project, response: projectResponse })).toMatchObject({
      kind: 'attached',
    });
    journal.publish({ kind: 'run', runId: 'run-1' }, 'run.created', { status: 'queued' });
    expect(projectResponse.writes).toEqual([]);
    projectResponse.emit('close');
    journal.dispose();
  });

  it('disconnects a backpressured client with typed resync and releases buffered bytes', () => {
    vi.useFakeTimers();
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      limits: { heartbeatMs: 100, slowClientMs: 10 },
      ownerKey: 'owner-a',
    });
    const response = new FakeResponse(false);
    const channel = { kind: 'run' as const, runId: 'run-1' };
    expect(journal.attach({ ownerKey: 'owner-a', channel, response })).toMatchObject({ kind: 'attached' });

    journal.publish(channel, 'run.progress', { delta: 'hello' });
    expect(budget.snapshot().bufferedBytes).toBeGreaterThan(0);
    vi.advanceTimersByTime(10);

    expect(response.writes.at(-1)).toBe('event: resync\ndata: {"reason":"slow-client"}\n\n');
    expect(response.writableEnded).toBe(true);
    expect(budget.snapshot()).toMatchObject({ bufferedBytes: 0, connections: 0 });
    journal.dispose();
    expect(budget.snapshot()).toEqual({ bufferedBytes: 0, bytes: 0, connections: 0, events: 0 });
  });

  it('clears backpressure on drain and disposal removes every timer and listener', () => {
    vi.useFakeTimers();
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      limits: { heartbeatMs: 100, slowClientMs: 10 },
      ownerKey: 'owner-a',
    });
    const response = new FakeResponse(false);
    const channel = { kind: 'owner' as const };
    journal.attach({ ownerKey: 'owner-a', channel, response });
    journal.publish(channel, 'owner.updated', { ok: true });
    response.emit('drain');
    vi.advanceTimersByTime(10);
    expect(response.writableEnded).toBe(false);
    expect(budget.snapshot()).toMatchObject({ bufferedBytes: 0, connections: 1 });

    const writesBeforeDispose = response.writes.length;
    journal.dispose();
    vi.advanceTimersByTime(1_000);
    expect(response.writes).toHaveLength(writesBeforeDispose);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
    expect(budget.snapshot()).toEqual({ bufferedBytes: 0, bytes: 0, connections: 0, events: 0 });
  });

  it('bounds retained events and bytes globally without evicting another owner', () => {
    const budget = createHostedEventBudget({ maxEvents: 1, maxBytes: 10_000 });
    const ownerA = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const ownerB = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-b',
    });
    ownerA.publish({ kind: 'owner' }, 'owner.updated', { owner: 'a' });
    expect(() => ownerB.publish({ kind: 'owner' }, 'owner.updated', { owner: 'b' })).toThrowError(
      expect.objectContaining({ code: 'HOSTED_CAPACITY_EXHAUSTED' }),
    );
    expect(budget.snapshot().events).toBe(1);

    ownerA.dispose();
    ownerB.publish({ kind: 'owner' }, 'owner.updated', { owner: 'b' });
    expect(budget.snapshot().events).toBe(1);
    ownerB.dispose();
    expect(budget.snapshot()).toEqual({ bufferedBytes: 0, bytes: 0, connections: 0, events: 0 });
  });

  it('resyncs an invalidated channel and accepts later events after pressure clears', () => {
    const budget = createHostedEventBudget({ maxEvents: 1, maxBytes: 10_000 });
    const pressure = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      ownerKey: 'owner-b',
    });
    const channel = { kind: 'project' as const, projectId: 'project-1' };
    const live = new FakeResponse();
    journal.attach({ ownerKey: 'owner-b', channel, response: live });
    pressure.publish({ kind: 'owner' }, 'owner.updated', { value: 1 });
    expect(() => journal.publish(channel, 'conversation-created', { value: 1 })).toThrow();

    journal.invalidate(channel);
    expect(live.writes.at(-1)).toBe('event: resync\ndata: {"reason":"cursor-expired"}\n\n');
    expect(live.writableEnded).toBe(true);
    pressure.dispose();

    const later = journal.publish(channel, 'conversation-created', { value: 2 });
    const reconnect = new FakeResponse();
    expect(journal.attach({ ownerKey: 'owner-b', channel, response: reconnect }))
      .toMatchObject({ kind: 'attached' });
    expect(reconnect.writes).toEqual([
      `id: ${later.cursor}\nevent: conversation-created\ndata: {"value":2}\n\n`,
    ]);
    journal.dispose();
  });

  it('enforces per-owner and global journal byte ceilings', () => {
    const ownerBudget = createHostedEventBudget();
    const ownerJournal = createHostedEventJournal({
      budget: ownerBudget,
      generation: 'generation-one',
      limits: { maxBytes: 128 },
      ownerKey: 'owner-a',
    });
    expect(() => ownerJournal.publish({ kind: 'owner' }, 'owner.updated', { value: 'x'.repeat(200) })).toThrowError(
      expect.objectContaining({ code: 'HOSTED_QUOTA_EXCEEDED' }),
    );
    ownerJournal.dispose();

    const globalBudget = createHostedEventBudget({ maxEvents: 20, maxBytes: 512 });
    const ownerA = createHostedEventJournal({
      budget: globalBudget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const ownerB = createHostedEventJournal({
      budget: globalBudget,
      generation: 'generation-one',
      ownerKey: 'owner-b',
    });
    ownerA.publish({ kind: 'owner' }, 'owner.updated', { value: 'a'.repeat(250) });
    expect(() => ownerB.publish({ kind: 'owner' }, 'owner.updated', { value: 'b'.repeat(250) })).toThrowError(
      expect.objectContaining({ code: 'HOSTED_CAPACITY_EXHAUSTED' }),
    );
    ownerA.dispose();
    ownerB.dispose();
  });

  it('disconnects immediately when a slow client crosses its buffered-byte quota', () => {
    const budget = createHostedEventBudget();
    const journal = createHostedEventJournal({
      budget,
      generation: 'generation-one',
      limits: { maxBufferedBytes: 1 },
      ownerKey: 'owner-a',
    });
    const response = new FakeResponse(false);
    const channel = { kind: 'run' as const, runId: 'run-1' };
    journal.attach({ ownerKey: 'owner-a', channel, response });
    journal.publish(channel, 'run.progress', { delta: 'hello' });

    expect(response.writes.at(-1)).toBe('event: resync\ndata: {"reason":"slow-client"}\n\n');
    expect(response.writableEnded).toBe(true);
    expect(budget.snapshot()).toMatchObject({ bufferedBytes: 0, connections: 0 });
    journal.dispose();
  });

  it('enforces injected per-owner and global connection limits', () => {
    const ownerBudget = createHostedEventBudget({ maxConnections: 10 });
    const ownerJournal = createHostedEventJournal({
      budget: ownerBudget,
      generation: 'generation-one',
      limits: { maxConnections: 1 },
      ownerKey: 'owner-a',
    });
    const channel = { kind: 'owner' as const };
    const first = new FakeResponse();
    expect(ownerJournal.attach({ ownerKey: 'owner-a', channel, response: first })).toMatchObject({ kind: 'attached' });
    expect(ownerJournal.attach({ ownerKey: 'owner-a', channel, response: new FakeResponse() })).toEqual({
      code: 'HOSTED_OVERLOADED',
      kind: 'overloaded',
    });
    ownerJournal.dispose();

    const globalBudget = createHostedEventBudget({ maxConnections: 1 });
    const ownerA = createHostedEventJournal({
      budget: globalBudget,
      generation: 'generation-one',
      ownerKey: 'owner-a',
    });
    const ownerB = createHostedEventJournal({
      budget: globalBudget,
      generation: 'generation-one',
      ownerKey: 'owner-b',
    });
    expect(ownerA.attach({ ownerKey: 'owner-a', channel, response: new FakeResponse() })).toMatchObject({ kind: 'attached' });
    expect(ownerB.attach({ ownerKey: 'owner-b', channel, response: new FakeResponse() })).toEqual({
      code: 'HOSTED_CAPACITY_EXHAUSTED',
      kind: 'overloaded',
    });
    ownerA.dispose();
    ownerB.dispose();
  });
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes: string[] = [];

  constructor(private readonly writeResult = true) {
    super();
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
