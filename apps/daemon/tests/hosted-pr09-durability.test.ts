import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startHostedServer,
  type HostedTestComposition,
} from '../src/hosted-server.js';
import {
  createHostedRuntimeRegistry,
  dispatchHostedRuntimeInternalOperation,
  HostedRuntimeError,
  type HostedRuntimeInternalOperation,
  type HostedRuntimeLease,
  type HostedRuntimeRegistry,
} from '../src/hosted-runtime-registry.js';
import {
  createHostedSnapshotStore,
  type HostedSnapshotStoreOptions,
} from '../src/hosted-snapshots.js';

const PUBLIC_ORIGIN = 'https://hosted.readable-studio.test';
const USER = 'pr09-durability-user';

type StartedServer = Awaited<ReturnType<typeof startHostedServer>>;

const servers: StartedServer[] = [];
const registries: HostedRuntimeRegistry[] = [];
const leases: HostedRuntimeLease[] = [];
const runtimeRoots: string[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) lease.release();
  for (const server of servers.splice(0).reverse()) {
    await server.shutdown().catch(() => {});
  }
  for (const registry of registries.splice(0).reverse()) {
    await registry.shutdown().catch(() => {});
  }
  for (const runtimeRoot of runtimeRoots.splice(0)) {
    rmSync(runtimeRoot, { force: true, recursive: true });
  }
});

describe('hosted PR09 durable acknowledgements', () => {
  it.each([
    [
      'metadata edit',
      {
        kind: 'metadata:mutate',
        operation: {
          kind: 'project.patch',
          projectId: 'project-1',
          body: { title: 'Durable title' },
        },
      },
    ],
    [
      'file edit',
      {
        kind: 'content:dispatch',
        request: {
          kind: 'file.write',
          projectId: 'project-1',
          body: {
            name: 'index.html',
            content: '<h1>durable</h1>',
            encoding: 'utf8',
            overwrite: true,
          },
        },
      },
    ],
    [
      'artifact save',
      {
        kind: 'artifact:save',
        request: { html: '<!doctype html><h1>durable artifact</h1>' },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, HostedRuntimeInternalOperation]>)
  ('does not acknowledge a %s before its complete snapshot', async (_label, operation) => {
    const events: string[] = [];
    const { lease, registry } = runtimeFixture({
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          async publish(input) {
            const publication = await snapshots.publish(input);
            events.push('snapshot:complete');
            return publication;
          },
        };
      },
    });
    await seedProject(registry, lease);
    events.length = 0;

    await dispatchHostedRuntimeInternalOperation(registry, lease, operation);
    events.push('acknowledged');

    expect(events).toContain('snapshot:complete');
    expect(events.at(-1)).toBe('acknowledged');
  });

  it('fails the mutation, poisons its generation, and restores the last complete state when publication fails', async () => {
    let failedPublicationsRemaining = 0;
    const { lease, registry } = runtimeFixture({
      createSnapshotStore(options) {
        const snapshots = createHostedSnapshotStore(options);
        return {
          restore: snapshots.restore,
          async publish(input) {
            if (failedPublicationsRemaining > 0) {
              failedPublicationsRemaining -= 1;
              throw new Error('simulated post-mutation publication failure');
            }
            return snapshots.publish(input);
          },
        };
      },
    });
    await seedProject(registry, lease);
    await dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'snapshot:publish',
      quiesce: async () => {},
    });

    failedPublicationsRemaining = 3;
    await expect(dispatchHostedRuntimeInternalOperation(registry, lease, {
      kind: 'metadata:mutate',
      operation: {
        kind: 'project.patch',
        projectId: 'project-1',
        body: { title: 'must not become authoritative' },
      },
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HostedRuntimeError);
      expect((error as HostedRuntimeError).code).toBe('HOSTED_RUNTIME_UNAVAILABLE');
      return true;
    });

    const failedGeneration = lease.generation;
    lease.release();
    const restored = registry.acquire({ userKey: USER });
    leases.push(restored);
    expect(restored.generation).toBeGreaterThan(failedGeneration);
    await expect(dispatchHostedRuntimeInternalOperation(registry, restored, {
      kind: 'metadata:read',
      operation: { kind: 'project.get', projectId: 'project-1' },
    })).resolves.toMatchObject({ project: { name: 'Baseline' } });
  });

  it('releases a stream attachment when header flushing fails synchronously', async () => {
    const { intent, started } = await runnableServer({
      eventBudgetLimits: { maxConnections: 1 },
    });
    const originalFlushHeaders = ServerResponse.prototype.flushHeaders;
    ServerResponse.prototype.flushHeaders = function flushHeaders(): void {
      throw new Error('simulated synchronous header flush failure');
    };
    try {
      await fetch(`${started.url}/api/projects/${String(intent.projectId)}/events`, {
        headers: { ...auth(), accept: 'text/event-stream' },
      }).then((response) => response.body?.cancel()).catch(() => {});
    } finally {
      ServerResponse.prototype.flushHeaders = originalFlushHeaders;
    }

    const healthy = await fetch(`${started.url}/api/projects/${String(intent.projectId)}/events`, {
      headers: { ...auth(), accept: 'text/event-stream' },
    });
    expect(healthy.status).toBe(200);
    await healthy.body?.cancel();
  });
});

describe('hosted PR09 durable run receipts', () => {
  it('returns the original run after a response-loss retry with the same clientRequestId and digest', async () => {
    let nextRun = 0;
    let turns = 0;
    const { csrf, intent, started } = await runnableServer({
      createRunId: () => `run-${++nextRun}`,
      async startTurn(input) {
        turns += 1;
        return succeededTurn(input);
      },
    });

    const lost = await mutate(started, csrf, 'POST', '/api/runs', intent);
    expect(lost.status, await lost.text()).toBe(202);
    await waitForRunStatus(started, 'run-1', 'succeeded');

    const retry = await mutate(started, csrf, 'POST', '/api/runs', intent);
    const retryText = await retry.text();
    expect(retry.status, retryText).toBe(202);
    expect(JSON.parse(retryText)).toMatchObject({ runId: 'run-1' });
    expect(turns).toBe(1);
  });

  it('returns the original run after a fresh generation loses its credential', async () => {
    const runtimeRoot = newRuntimeRoot();
    let turns = 0;
    const original = await start(runtimeRoot, {
      createRunId: () => 'restart-retry-run',
      async startTurn(input) {
        turns += 1;
        return succeededTurn(input);
      },
    });
    const { csrf, intent } = await seedRunnable(original, 'restart-retry-request');
    const accepted = await mutate(original, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await waitForRunStatus(original, 'restart-retry-run', 'succeeded');
    await stop(original);

    const restarted = await start(runtimeRoot);
    const session = await json<{ csrfToken: string }>(await fetch(
      `${restarted.url}/api/hosted/session`,
      { headers: auth() },
    ));
    const retry = await mutate(restarted, session.csrfToken, 'POST', '/api/runs', intent);
    const retryText = await retry.text();
    expect(retry.status, retryText).toBe(202);
    expect(JSON.parse(retryText)).toMatchObject({ runId: 'restart-retry-run' });
    expect(turns).toBe(1);
  });

  it('rejects reuse of a clientRequestId with a changed canonical digest', async () => {
    let nextRun = 0;
    const { csrf, intent, started } = await runnableServer({
      createRunId: () => `digest-run-${++nextRun}`,
      startTurn: succeededTurn,
    });
    const accepted = await mutate(started, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await waitForRunStatus(started, 'digest-run-1', 'succeeded');

    const changed = await mutate(started, csrf, 'POST', '/api/runs', {
      ...intent,
      message: 'different provider intent under the copied retry key',
    });
    const text = await changed.text();
    expect(changed.status, text).toBe(409);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'RETRY_KEY_REUSED' } });
  });

  it('binds the retry digest to the /runs or /chat admission contract', async () => {
    const { csrf, intent, started } = await runnableServer({
      createRunId: () => 'route-bound-run',
      startTurn: succeededTurn,
    });
    const accepted = await mutate(started, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await waitForRunStatus(started, 'route-bound-run', 'succeeded');

    const copiedToChat = await mutate(started, csrf, 'POST', '/api/chat', intent);
    const text = await copiedToChat.text();
    expect(copiedToChat.status, text).toBe(409);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'RETRY_KEY_REUSED' } });
  });

  it.each([
    ['succeeded', false],
    ['canceled', true],
  ] as const)('restores a durably %s run after a fresh server generation', async (status, cancel) => {
    const runtimeRoot = newRuntimeRoot();
    const runId = `terminal-${status}`;
    const started = await start(runtimeRoot, {
      createRunId: () => runId,
      async startTurn(input) {
        if (!cancel) return succeededTurn(input);
        writeSession(input);
        return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({
          sessionReference: sessionPath(input),
          value: { status: 'canceled', exitCode: null, signal: null },
        }), { once: true }));
      },
    });
    const { csrf, intent } = await seedRunnable(started, `retry-${status}`);
    const accepted = await mutate(started, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    if (cancel) {
      await waitForRunStatus(started, runId, 'running');
      const canceled = await mutate(started, csrf, 'POST', `/api/runs/${runId}/cancel`);
      expect(canceled.status, await canceled.text()).toBe(200);
    }
    await waitForRunStatus(started, runId, status);
    await stop(started);

    const restarted = await start(runtimeRoot);
    const restored = await fetch(`${restarted.url}/api/runs/${runId}`, {
      headers: auth(),
    });
    const restoredText = await restored.text();
    expect(restored.status, restoredText).toBe(200);
    expect(JSON.parse(restoredText)).toMatchObject({ id: runId, status });
  });

  it('replays durable run boundaries after a fresh server generation', async () => {
    const runtimeRoot = newRuntimeRoot();
    const runId = 'replayed-run';
    const original = await start(runtimeRoot, {
      createRunId: () => runId,
      startTurn: succeededTurn,
    });
    const { csrf, intent } = await seedRunnable(original, 'replayed-run-request');
    const accepted = await mutate(original, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await waitForRunStatus(original, runId, 'succeeded');
    await stop(original);

    const restarted = await start(runtimeRoot);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 2_000);
    try {
      const replay = await fetch(`${restarted.url}/api/runs/${runId}/events`, {
        headers: { ...auth(), accept: 'text/event-stream' },
        signal: abort.signal,
      });
      const replayText = await replay.text();
      expect(replay.status, replayText).toBe(200);
      expect(replayText.match(/^event: (start|end)$/gmu)).toEqual([
        'event: start',
        'event: end',
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });

  it('restores a failed receipt and replays its durable error boundary', async () => {
    const runtimeRoot = newRuntimeRoot();
    const runId = 'failed-replayed-run';
    const original = await start(runtimeRoot, {
      createRunId: () => runId,
      async startTurn() {
        throw new HostedRuntimeError('INTERNAL_ERROR', 'simulated provider failure');
      },
    });
    const { csrf, intent } = await seedRunnable(original, 'failed-replayed-request');
    const accepted = await mutate(original, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await waitForRunStatus(original, runId, 'failed');
    await stop(original);

    const restarted = await start(runtimeRoot);
    const restored = await fetch(`${restarted.url}/api/runs/${runId}`, { headers: auth() });
    const restoredText = await restored.text();
    expect(restored.status, restoredText).toBe(200);
    expect(JSON.parse(restoredText)).toMatchObject({ id: runId, status: 'failed' });

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 2_000);
    try {
      const replay = await fetch(`${restarted.url}/api/runs/${runId}/events`, {
        headers: { ...auth(), accept: 'text/event-stream' },
        signal: abort.signal,
      });
      const replayText = await replay.text();
      expect(replay.status, replayText).toBe(200);
      expect(replayText.match(/^event: (start|error|end)$/gmu)).toEqual([
        'event: start',
        'event: error',
        'event: end',
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });

  it('accepts only one concurrent response to a pending GenUI surface', async () => {
    const runId = 'concurrent-genui-run';
    const surfaceId = 'approval';
    const { csrf, intent, started } = await runnableServer({
      createRunId: () => runId,
      async startTurn(input) {
        input.send('genui', {
          kind: 'ui.surface_requested',
          surfaceId,
          surfaceKind: 'confirmation',
          payload: { prompt: 'Approve?' },
        });
        return succeededTurn(input);
      },
    });
    const accepted = await mutate(started, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await waitForRunStatus(started, runId, 'succeeded');

    const responses = await Promise.all([
      mutate(started, csrf, 'POST', `/api/runs/${runId}/genui/${surfaceId}/respond`, {
        value: 'first',
      }),
      mutate(started, csrf, 'POST', `/api/runs/${runId}/genui/${surfaceId}/respond`, {
        value: 'second',
      }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 404]);
  });

  it('restores accepted nonterminal work as interrupted and never replays provider effects', async () => {
    const runtimeRoot = newRuntimeRoot();
    let originalTurns = 0;
    let restoredTurns = 0;
    const original = await start(runtimeRoot, {
      createRunId: () => 'interrupted-run',
      async startTurn(input) {
        originalTurns += 1;
        writeSession(input);
        return new Promise((resolve) => input.signal.addEventListener('abort', () => resolve({
          sessionReference: sessionPath(input),
          value: { status: 'canceled', exitCode: null, signal: null },
        }), { once: true }));
      },
    });
    const { csrf, intent } = await seedRunnable(original, 'interrupted-retry');
    const accepted = await mutate(original, csrf, 'POST', '/api/runs', intent);
    expect(accepted.status, await accepted.text()).toBe(202);
    await eventually(() => expect(originalTurns).toBe(1));

    const restarted = await start(runtimeRoot, {
      async startTurn(input) {
        restoredTurns += 1;
        return succeededTurn(input);
      },
    });
    const restored = await fetch(`${restarted.url}/api/runs/interrupted-run`, {
      headers: auth(),
    });
    const text = await restored.text();
    expect(restored.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      id: 'interrupted-run',
      status: 'interrupted',
      resumable: true,
    });
    expect(restoredTurns).toBe(0);
  });
});

function runtimeFixture(overrides: {
  createSnapshotStore(options: HostedSnapshotStoreOptions): ReturnType<typeof createHostedSnapshotStore>;
}): { lease: HostedRuntimeLease; registry: HostedRuntimeRegistry } {
  const runtimeRoot = newRuntimeRoot();
  const registry = createHostedRuntimeRegistry({
    runtimeRoot,
    createEntityId: (kind) => `${kind}-1`,
    ...overrides,
  });
  const lease = registry.acquire({ userKey: USER });
  registries.push(registry);
  leases.push(lease);
  return { lease, registry };
}

async function seedProject(
  registry: HostedRuntimeRegistry,
  lease: HostedRuntimeLease,
): Promise<void> {
  await dispatchHostedRuntimeInternalOperation(registry, lease, {
    kind: 'metadata:mutate',
    operation: { kind: 'project.create', body: { title: 'Baseline' } },
  });
}

async function runnableServer(
  composition: Pick<
    HostedTestComposition,
    'createRunId' | 'eventBudgetLimits' | 'startTurn'
  >,
): Promise<{
  csrf: string;
  intent: Record<string, unknown>;
  started: StartedServer;
}> {
  const started = await start(newRuntimeRoot(), composition);
  return { started, ...await seedRunnable(started, 'stable-retry-key') };
}

async function start(
  runtimeRoot: string,
  composition: Pick<HostedTestComposition, 'createRunId' | 'startTurn'> = {},
): Promise<StartedServer> {
  const counters = new Map<string, number>();
  const started = await startHostedServer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: PUBLIC_ORIGIN,
    runtimeRoot,
    testComposition: {
      createEntityId(kind) {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return `${kind}-${next}`;
      },
      resolveIdentity(request) {
        return request.headers.authorization === `Bearer ${USER}`
          ? { userKey: USER, sessionKey: 'pr09-session' }
          : null;
      },
      ...composition,
    },
  });
  servers.push(started);
  return started;
}

async function stop(started: StartedServer): Promise<void> {
  const index = servers.indexOf(started);
  if (index >= 0) servers.splice(index, 1);
  await started.shutdown();
}

async function seedRunnable(
  started: StartedServer,
  clientRequestId: string,
): Promise<{ csrf: string; intent: Record<string, unknown> }> {
  const session = await fetch(`${started.url}/api/hosted/session`, { headers: auth() });
  const csrf = (await json<{ csrfToken: string }>(session)).csrfToken;
  const project = await json<{ project: { id: string } }>(await mutate(
    started,
    csrf,
    'POST',
    '/api/projects',
    { title: 'Durable run project', kind: 'prototype' },
  ));
  const conversation = await json<{ conversation: { id: string } }>(await mutate(
    started,
    csrf,
    'POST',
    `/api/projects/${project.project.id}/conversations`,
    { title: 'Durable run conversation', sessionMode: 'design' },
  ));
  const assistantMessageId = 'assistant-message';
  await expectOk(await mutate(
    started,
    csrf,
    'PUT',
    `/api/projects/${project.project.id}/conversations/${conversation.conversation.id}/messages/${assistantMessageId}`,
    { role: 'assistant', content: '' },
  ));
  await expectOk(await mutate(started, csrf, 'PUT', '/api/hosted/provider', {
    provider: 'anthropic',
    key: 'test-only-pr09-key',
  }));
  return {
    csrf,
    intent: {
      projectId: project.project.id,
      conversationId: conversation.conversation.id,
      assistantMessageId,
      agentId: 'pi',
      message: 'build the durable design',
      clientRequestId,
    },
  };
}

async function mutate(
  started: StartedServer,
  csrf: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${started.url}${path}`, {
    method,
    headers: {
      ...auth(),
      'content-type': 'application/json',
      'x-readable-studio-csrf': csrf,
      origin: PUBLIC_ORIGIN,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${USER}` };
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBeGreaterThanOrEqual(200);
  expect(response.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}

async function expectOk(response: Response): Promise<void> {
  const text = await response.text();
  expect(response.status, text).toBeGreaterThanOrEqual(200);
  expect(response.status, text).toBeLessThan(300);
}

async function waitForRunStatus(
  started: StartedServer,
  runId: string,
  status: string,
): Promise<void> {
  await eventually(async () => {
    const response = await fetch(`${started.url}/api/runs/${runId}`, { headers: auth() });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ status });
  });
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function succeededTurn(
  input: Parameters<NonNullable<HostedTestComposition['startTurn']>>[0],
) {
  writeSession(input);
  return Promise.resolve({
    sessionReference: sessionPath(input),
    value: { status: 'succeeded' as const, exitCode: 0, signal: null },
  });
}

function writeSession(
  input: Parameters<NonNullable<HostedTestComposition['startTurn']>>[0],
): void {
  mkdirSync(input.capabilities.sessionRoot, { recursive: true });
  writeFileSync(
    sessionPath(input),
    `${JSON.stringify({ type: 'session', cwd: input.capabilities.projectRoot })}\n`,
  );
}

function sessionPath(
  input: Parameters<NonNullable<HostedTestComposition['startTurn']>>[0],
): string {
  return join(input.capabilities.sessionRoot, `${input.capabilities.runId}.jsonl`);
}

function newRuntimeRoot(): string {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'readable-hosted-pr09-durability-'));
  runtimeRoots.push(runtimeRoot);
  return runtimeRoot;
}
