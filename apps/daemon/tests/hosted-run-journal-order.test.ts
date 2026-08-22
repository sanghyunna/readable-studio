import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { NormalizedHostedRunIntentV1 } from '../src/hosted-run-adapter.js';
import {
  createHostedRuntimeRegistry,
  dispatchHostedRuntimeInternalOperation,
  type HostedRuntimeLease,
  type HostedRuntimeRegistry,
} from '../src/hosted-runtime-registry.js';
import { createHostedSnapshotStore } from '../src/hosted-snapshots.js';
import { createChatRunService } from '../src/runs.js';

const roots: string[] = [];
const registries: HostedRuntimeRegistry[] = [];
const leases: HostedRuntimeLease[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release();
  for (const registry of registries.splice(0).reverse()) await registry.shutdown().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('hosted run journal ordering', () => {
  it('snapshots each authoritative run transition before provider effects or SSE', async () => {
    const order: string[] = [];
    let terminalCursor: string | null = null;
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-run-journal-order-'));
    roots.push(runtimeRoot);
    const registry = createHostedRuntimeRegistry({
      runtimeRoot,
      createEntityId: (kind) => `${kind}-1`,
      createRunService(options) {
        const service = createChatRunService(options);
        return {
          ...service,
          finish(...args: Parameters<typeof service.finish>) {
            order.push('memory:terminal');
            return service.finish(...args);
          },
        };
      },
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          async publish(input) {
            const publication = await snapshots.publish(input);
            const receipt = input.storage.database.prepare(
              'SELECT status FROM hosted_run_receipts WHERE client_request_id = ?',
            ).get('retry-1') as { status?: string } | undefined;
            if (receipt?.status != null) {
              const journal = JSON.parse(readFileSync(
                join(input.storage.roots.runsRoot, '.hosted-event-journal.json'),
                'utf8',
              )) as { events: Array<{ event: string }> };
              if (receipt.status === 'succeeded') {
                const message = input.storage.database.prepare(
                  `SELECT content, run_status AS runStatus,
                          last_run_event_id AS lastRunEventId
                     FROM messages WHERE id = ?`,
                ).get('message-1') as {
                  content?: string;
                  lastRunEventId?: string | null;
                  runStatus?: string | null;
                } | undefined;
                terminalCursor = message?.lastRunEventId ?? null;
                order.push(
                  `terminal-message:${message?.content}:${message?.runStatus}:${Boolean(message?.lastRunEventId)}`,
                );
              }
              order.push(`snapshot:${receipt.status}:${journal.events.at(-1)?.event}`);
            }
            return publication;
          },
        };
      },
      async startTurn(input) {
        order.push('provider:start');
        input.send('progress', { delta: 'one' });
        input.send('ui.surface', { kind: 'ui.surface_created', surfaceId: 'surface-1' });
        input.send('progress', { delta: 'two' });
        input.send('assistant', { delta: 'answer' });
        const sessionReference = join(input.capabilities.sessionRoot, 'run-1.jsonl');
        writeFileSync(sessionReference, `${JSON.stringify({
          type: 'session',
          cwd: input.capabilities.projectRoot,
        })}\n`);
        return {
          sessionReference,
          value: { status: 'succeeded', exitCode: 0, signal: null },
        };
      },
    });
    registries.push(registry);
    const lease = registry.acquire({ userKey: 'run-journal-user' });
    leases.push(lease);
    await seedRunOwner(registry, lease);

    for (const channel of [
      { kind: 'run' as const, runId: 'run-1' },
      { kind: 'run-ui' as const, runId: 'run-1' },
    ]) {
      const response = new PassThrough();
      response.on('data', (chunk) => {
        const frame = String(chunk);
        const event = /^event: ([^\r\n]+)/mu.exec(frame)?.[1];
        if (event != null) order.push(`sse:${event}`);
      });
      await dispatchHostedRuntimeInternalOperation(registry, lease, {
        kind: 'journal:attach',
        channel,
        response,
      });
    }

    const result = await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'run:start',
      runId: 'run-1',
      intent: runIntent(),
      model: 'hosted-model',
      modelCatalogue: ['hosted-model'],
      thinkingCatalogue: [],
      mapEvent: mapRunEvent,
    });
    order.push('admission:ack');
    expect(result).toMatchObject({ runId: 'run-1' });
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'run:wait',
      runId: 'run-1',
    });

    expect(terminalCursor).not.toBeNull();
    await expect(dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'journal:replay',
      channel: { kind: 'run', runId: 'run-1' },
      after: terminalCursor,
    })).resolves.toEqual({ kind: 'events', events: [] });

    expect(before(order, 'snapshot:queued:run.created', 'admission:ack')).toBe(true);
    expect(before(order, 'snapshot:running:run.started', 'provider:start')).toBe(true);
    expect(inOrder(order, [
      'sse:run.progress',
      'snapshot:running:ui.surface',
      'sse:ui.surface',
      'sse:run.progress',
      'terminal-message:answer:succeeded:true',
      'snapshot:succeeded:run.lifecycle',
      'memory:terminal',
      'sse:run.finished',
    ]), JSON.stringify(order)).toBe(true);
  });

  it('rolls back an unpublished run-created batch and poisons its generation', async () => {
    let failPublication = false;
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-run-journal-failure-'));
    roots.push(runtimeRoot);
    const registry = createHostedRuntimeRegistry({
      runtimeRoot,
      createEntityId: (kind) => `${kind}-1`,
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          publish(input) {
            return failPublication
              ? Promise.reject(new Error('simulated publication failure'))
              : snapshots.publish(input);
          },
        };
      },
    });
    registries.push(registry);
    const lease = registry.acquire({ userKey: 'run-journal-failure-user' });
    leases.push(lease);
    await seedRunOwner(registry, lease);
    const stream = new PassThrough();
    let bytes = '';
    stream.on('data', (chunk) => { bytes += String(chunk); });
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'journal:attach',
      channel: { kind: 'run', runId: 'run-1' },
      response: stream,
    });

    failPublication = true;
    const start = dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'run:start',
      runId: 'run-1',
      intent: runIntent(),
      model: 'hosted-model',
      modelCatalogue: ['hosted-model'],
      thinkingCatalogue: [],
      mapEvent: mapRunEvent,
    });
    await expect(start).rejects.toMatchObject({
      code: 'HOSTED_RUNTIME_UNAVAILABLE',
    });
    expect(bytes).not.toContain('event: run.created');

    const failedGeneration = lease.generation;
    lease.release();
    failPublication = false;
    const restored = registry.acquire({ userKey: 'run-journal-failure-user' });
    leases.push(restored);
    expect(restored.generation).toBeGreaterThan(failedGeneration);
    await expect(dispatchHostedRuntimeInternalOperation(registry, restored, {
      kind: 'journal:replay',
      channel: { kind: 'run', runId: 'run-1' },
    })).resolves.toEqual({ kind: 'events', events: [] });
    await expect(dispatchHostedRuntimeInternalOperation(registry, restored, {
      kind: 'run:get',
      runId: 'run-1',
    })).resolves.toBeNull();
  });

  it('finishes shutdown cancellation on the already-active runtime before terminal SSE', async () => {
    const providerStarted = deferred();
    const terminalSeen = deferred();
    const order: string[] = [];
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-run-journal-shutdown-'));
    roots.push(runtimeRoot);
    const registry = createHostedRuntimeRegistry({
      runtimeRoot,
      createEntityId: (kind) => `${kind}-1`,
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          async publish(input) {
            const publication = await snapshots.publish(input);
            const receipt = input.storage.database.prepare(
              'SELECT status FROM hosted_run_receipts WHERE client_request_id = ?',
            ).get('retry-1') as { status?: string } | undefined;
            if (receipt?.status === 'canceled') order.push('snapshot:canceled');
            return publication;
          },
        };
      },
      startTurn(input) {
        providerStarted.resolve();
        return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({
          sessionReference: 'unused-on-cancel',
          value: { status: 'canceled', exitCode: null, signal: null },
        }), { once: true }));
      },
    });
    registries.push(registry);
    const lease = registry.acquire({ userKey: 'run-journal-shutdown-user' });
    leases.push(lease);
    await seedRunOwner(registry, lease);
    const response = new PassThrough();
    response.on('data', (chunk) => {
      if (!String(chunk).includes('event: run.finished')) return;
      order.push('sse:terminal');
      terminalSeen.resolve();
    });
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'journal:attach',
      channel: { kind: 'run', runId: 'run-1' },
      response,
    });
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'run:start',
      runId: 'run-1',
      intent: runIntent(),
      model: 'hosted-model',
      modelCatalogue: ['hosted-model'],
      thinkingCatalogue: [],
      mapEvent: mapRunEvent,
    });
    await providerStarted.promise;

    const shutdown = registry.shutdown();
    await terminalSeen.promise;
    expect(order).toEqual(['snapshot:canceled', 'sse:terminal']);
    lease.release();
    await shutdown;
  });

  it('snapshots a queued cancellation before terminal SSE and restores it', async () => {
    const blockerStarted = deferred();
    const releaseBlocker = deferred();
    const terminalSeen = deferred();
    const targetRetired = deferred();
    const order: string[] = [];
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-run-journal-queued-cancel-'));
    roots.push(runtimeRoot);
    const registry = createHostedRuntimeRegistry({
      runtimeRoot,
      createEntityId: (kind) => `${kind}-1`,
      idleEvictionMs: 1,
      limits: { activeChildren: 1 },
      onGenerationRetired(binding) {
        if (binding.userKey === 'queued-cancel-user') targetRetired.resolve();
      },
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          async publish(input) {
            const publication = await snapshots.publish(input);
            const receipt = input.storage.database.prepare(
              'SELECT status FROM hosted_run_receipts WHERE client_request_id = ?',
            ).get('retry-1') as { status?: string } | undefined;
            if (receipt?.status === 'canceled') order.push('snapshot:canceled');
            return publication;
          },
        };
      },
      async startTurn() {
        throw new Error('a canceled queued run must not reach the provider');
      },
    });
    registries.push(registry);
    const blockerLease = registry.acquire({ userKey: 'capacity-blocker-user' });
    leases.push(blockerLease);
    const blocker = registry.dispatch(blockerLease, {
      conversationId: 'blocker-conversation',
      runId: 'blocker-run',
      async execute() {
        blockerStarted.resolve();
        await releaseBlocker.promise;
        return { value: undefined };
      },
    });
    await blockerStarted.promise;

    const lease = registry.acquire({ userKey: 'queued-cancel-user' });
    leases.push(lease);
    await seedRunOwner(registry, lease);
    const response = new PassThrough();
    response.on('data', (chunk) => {
      if (!String(chunk).includes('event: run.finished')) return;
      order.push('sse:terminal');
      terminalSeen.resolve();
    });
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'journal:attach',
      channel: { kind: 'run', runId: 'run-1' },
      response,
    });
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'run:start',
      runId: 'run-1',
      intent: runIntent(),
      model: 'hosted-model',
      modelCatalogue: ['hosted-model'],
      thinkingCatalogue: [],
      mapEvent: mapRunEvent,
    });

    expect(registry.cancel({
      userKey: lease.userKey,
      generation: lease.generation,
      runId: 'run-1',
    })).toBe(true);
    const finishedWithoutChildCapacity = await Promise.race([
      terminalSeen.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    releaseBlocker.resolve();
    await blocker;
    expect(finishedWithoutChildCapacity).toBe(true);
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'run:wait',
      runId: 'run-1',
    });
    expect(order).toEqual(['snapshot:canceled', 'sse:terminal']);

    response.destroy();
    lease.release();
    await targetRetired.promise;
    const restored = registry.acquire({ userKey: 'queued-cancel-user' });
    leases.push(restored);
    await expect(dispatchHostedRuntimeInternalOperation(registry, restored, {
      kind: 'run:get',
      runId: 'run-1',
    })).resolves.toMatchObject({ status: 'canceled' });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mapRunEvent(channel: string, payload: Record<string, unknown>) {
  const status = payload.status;
  if (channel === 'run.lifecycle' && status === 'created') {
    return [event('run', 'run.created', payload, 'run-created')];
  }
  if (channel === 'run.lifecycle' && status === 'started') {
    return [event('run', 'run.started', payload, 'status-transition')];
  }
  if (channel === 'run.lifecycle') {
    return [
      event('run', 'run.finished', payload, 'terminal'),
      event('run-ui', 'run.lifecycle', payload, 'terminal'),
    ];
  }
  if (channel === 'ui.surface') {
    return [event('run-ui', 'ui.surface', payload, 'status-transition')];
  }
  if (channel === 'assistant') {
    return [event('run', 'agent', { type: 'text_delta', delta: payload.delta }, null)];
  }
  return [event('run', 'run.progress', payload, null)];
}

function event(
  kind: 'run' | 'run-ui',
  name: string,
  data: Record<string, unknown>,
  milestone: 'run-created' | 'status-transition' | 'terminal' | null,
) {
  return { channel: { kind, runId: 'run-1' }, data, event: name, milestone } as const;
}

function before(values: readonly string[], first: string, second: string): boolean {
  return values.indexOf(first) >= 0 && values.indexOf(first) < values.indexOf(second);
}

function inOrder(values: readonly string[], expected: readonly string[]): boolean {
  let at = 0;
  for (const value of values) if (value === expected[at]) at += 1;
  return at === expected.length;
}

async function seedRunOwner(
  registry: HostedRuntimeRegistry,
  lease: HostedRuntimeLease,
): Promise<void> {
  await dispatchHostedRuntimeInternalOperation(registry, lease, {
    kind: 'metadata:mutate',
    operation: { kind: 'project.create', body: { title: 'Project' } },
  });
  await dispatchHostedRuntimeInternalOperation(registry, lease, {
    kind: 'metadata:mutate',
    operation: { kind: 'conversation.create', projectId: 'project-1', body: {} },
  });
  await dispatchHostedRuntimeInternalOperation(registry, lease, {
    kind: 'metadata:mutate',
    operation: {
      kind: 'message.upsert',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      body: { role: 'assistant', content: '' },
    },
  });
  await registry.replaceCredential(lease, { provider: 'anthropic', key: 'test-key' });
}

function runIntent(): NormalizedHostedRunIntentV1 {
  return {
    projectId: 'project-1',
    conversationId: 'conversation-1',
    assistantMessageId: 'message-1',
    agentId: 'pi',
    message: 'Build it',
    currentPrompt: 'Build it',
    clientRequestId: 'retry-1',
    sessionMode: 'design',
    skillIds: [],
    designSystemId: null,
    attachmentIds: [],
    commentAttachmentIds: [],
    model: null,
    reasoning: null,
    locale: 'en',
    contextSelectionIds: [],
  };
}
