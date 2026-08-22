// @vitest-environment node

import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import {
  HOSTED_ASSISTANT_MESSAGE_ID,
  expectHttpStatus,
  jsonMutation,
  startRun,
  waitForRun,
} from '@/hosted-http';
import {
  HOSTED_CAPACITY_IDENTITIES,
  type HostedCapacityIdentity,
  type HostedHttpClient,
  type HostedMeasurement,
} from '@/hosted';
import { createSmokeSuite, type SmokeSuite } from '@/smoke-suite';

type ProjectResponse = { project: { id: string } };
type ConversationResponse = { conversation: { id: string } };
type CheckpointsResponse = { checkpoints: Array<{ runId: string | null }> };

type CapacityUser = {
  client: HostedHttpClient;
  conversationId: string;
  identity: HostedCapacityIdentity;
  input: string;
  projectId: string;
};

type StreamMetrics = {
  durationMs: number;
  eventCounts: Record<string, number>;
  firstTokenMs: number;
  queueWaitMs: number;
  streamGapsMs: number[];
  text: string;
};

const LEVELS = [1, 2, 4, 8] as const;
const CAPACITY_PROMPT = '[capacity-v1] Read input.txt with readable_hosted_broker, then report completion.';

describe('hosted local capacity baseline', () => {
  test('runs a comparable deterministic 1/2/4/8-user workload twice', async () => {
    const first = await runCapacityRepetition(1);
    const second = await runCapacityRepetition(2);

    expect(second.semantic).toEqual(first.semantic);
    await second.suite.report.json('capacity-comparison.json', {
      comparable: true,
      contract: 'hosted-capacity-v1',
      repetitions: 2,
      semantic: second.semantic,
    });
  }, 1_800_000);
});

async function runCapacityRepetition(repetition: number): Promise<{
  semantic: unknown;
  suite: SmokeSuite;
}> {
  const suite = await createSmokeSuite(`hosted-capacity-${repetition}`);
  let semantic: unknown;

  await suite.with.hosted(async (context) => {
    const users: CapacityUser[] = [];
    const levels: Array<Record<string, unknown>> = [];
    const runIds = new Map<HostedCapacityIdentity, string>();
    let offset = 0;

    for (const admittedUsers of LEVELS) {
      const identities = HOSTED_CAPACITY_IDENTITIES.slice(offset, offset + admittedUsers);
      offset += admittedUsers;
      const before = await context.measure();
      expectIdle(before);
      const providerStart = context.provider.requestSummary().requests.length;
      const levelUsers = await Promise.all(identities.map(async (identity) => {
        const client = context.identity(identity);
        const input = `[capacity-input:${identity}]`;
        const project = await jsonMutation<ProjectResponse>(client, 'POST', '/api/projects', {
          title: 'Capacity project', kind: 'prototype',
        });
        await jsonMutation(client, 'POST', `/api/projects/${project.project.id}/files`, {
          name: 'input.txt', content: input,
        });
        const conversation = await jsonMutation<ConversationResponse>(
          client,
          'POST',
          `/api/projects/${project.project.id}/conversations`,
          { title: 'Capacity conversation', sessionMode: 'design' },
        );
        await jsonMutation(
          client,
          'PUT',
          `/api/projects/${project.project.id}/conversations/${conversation.conversation.id}/messages/${HOSTED_ASSISTANT_MESSAGE_ID}`,
          { role: 'assistant', content: '' },
        );
        return {
          client,
          conversationId: conversation.conversation.id,
          identity,
          input,
          projectId: project.project.id,
        };
      }));
      users.push(...levelUsers);
      await Promise.all(levelUsers.map((user) => jsonMutation(
        user.client,
        'PUT',
        '/api/hosted/provider',
        { provider: 'anthropic', key: context.provider.credential(user.identity) },
      )));

      const admissions = await Promise.all(levelUsers.map(async (user) => {
        const requestedAt = performance.now();
        const run = await startRun(
          user.client,
          user.projectId,
          user.conversationId,
          `capacity-${user.identity}`,
          CAPACITY_PROMPT,
        );
        return {
          runId: run.runId,
          stream: collectRunStream(user.client, run.runId, requestedAt),
          user,
        };
      }));
      for (const admission of admissions) runIds.set(admission.user.identity, admission.runId);
      const active = await context.measure();
      expect(active.registry.residentRuntimes).toBeLessThanOrEqual(admittedUsers);
      expect(active.registry.activeChildren).toBeLessThanOrEqual(admittedUsers);
      expect(active.registry.queuedMutations).toBeLessThanOrEqual(admittedUsers);
      expect(active.registry.laneOperations).toBeLessThanOrEqual(admittedUsers);

      const completed = await Promise.all(admissions.map(async (admission) => {
        const [stream, status, file] = await Promise.all([
          capacityStep(admission.user.identity, 'stream', admission.stream),
          capacityStep(
            admission.user.identity,
            'status',
            waitForRun(admission.user.client, admission.runId, 'succeeded', 300_000),
          ),
          capacityStep(admission.user.identity, 'file', expectHttpStatus(
            admission.user.client,
            `/api/projects/${admission.user.projectId}/files/input.txt`,
            200,
          ).then((response) => response.text())),
        ]);
        expect(file).toBe(admission.user.input);
        expect(stream.text).toBe(`${admission.user.input}Capacity read complete.`);
        return {
          eventCounts: stream.eventCounts,
          firstTokenMs: stream.firstTokenMs,
          identity: admission.user.identity,
          queueWaitMs: stream.queueWaitMs,
          runId: admission.runId,
          status: status.status,
          streamDurationMs: stream.durationMs,
          streamGapsMs: stream.streamGapsMs,
        };
      }));

      const providerRequests = context.provider.requestSummary().requests.slice(providerStart);
      for (const identity of identities) {
        const requests = providerRequests.filter((request) => request.credential === identity);
        expect(requests.map((request) => request.capacityPhase)).toEqual(['tool-use', 'final']);
        expect(requests[1]?.capacityInputMarker).toBe(identity);
      }
      expect(providerRequests).toHaveLength(admittedUsers * 2);

      const completedMeasurement = await context.measure();
      const idle = await waitForIdle(context.measure);
      const operations = idle.operations.slice(before.operations.length);
      expect(operations.some((measurement) => measurement.kind === 'checkpoint')).toBe(true);
      expect(operations.some((measurement) => measurement.kind === 'snapshot')).toBe(true);
      const finalSnapshots = new Map<string, (typeof operations)[number]>();
      for (const operation of operations) {
        if (operation.kind === 'checkpoint') expect(operation.ok).toBe(true);
        else finalSnapshots.set(operation.userKey, operation);
        expect(operation.durationMs).toBeGreaterThanOrEqual(0);
        if (operation.bytes != null) expect(operation.bytes).toBeGreaterThan(0);
        if (operation.fileCount != null) expect(operation.fileCount).toBeGreaterThanOrEqual(0);
      }
      for (const snapshot of finalSnapshots.values()) expect(snapshot.ok).toBe(true);
      levels.push({
        admittedUsers,
        measurements: { active, before, completed: completedMeasurement, idle },
        operations,
        provider: {
          requests: providerRequests.length,
          toolRoundTrips: identities.length,
        },
        users: completed,
      });
    }

    await context.restart('graceful');
    await Promise.all(users.map(async (user, index) => {
      const ownFile = await expectHttpStatus(
        user.client,
        `/api/projects/${user.projectId}/files/input.txt`,
        200,
      ).then((response) => response.text());
      expect(ownFile).toBe(user.input);
      const runId = runIds.get(user.identity)!;
      expect((await waitForRun(user.client, runId, 'succeeded')).status).toBe('succeeded');
      const checkpoints = await user.client.json<CheckpointsResponse>(
        `/api/projects/${user.projectId}/checkpoints?conversationId=${encodeURIComponent(user.conversationId)}`,
      );
      expect(checkpoints.checkpoints.some((checkpoint) => checkpoint.runId === runId)).toBe(true);
      const foreign = users[(index + 1) % users.length]!;
      await (await expectHttpStatus(foreign.client, `/api/runs/${runId}`, 404)).arrayBuffer();
      expect(await expectHttpStatus(
        foreign.client,
        `/api/projects/${user.projectId}/files/input.txt`,
        200,
      ).then((response) => response.text())).toBe(foreign.input);
    }));

    const privateOwner = users.at(-1)!;
    const foreignReader = users[0]!;
    const privateProject = await jsonMutation<ProjectResponse>(
      privateOwner.client,
      'POST',
      '/api/projects',
      { title: 'Capacity private project', kind: 'prototype' },
    );
    expect(privateProject.project.id).not.toBe(foreignReader.projectId);
    await jsonMutation(privateOwner.client, 'POST', `/api/projects/${privateProject.project.id}/files`, {
      name: 'private.txt', content: privateOwner.input,
    });
    await (await expectHttpStatus(
      foreignReader.client,
      `/api/projects/${privateProject.project.id}/files/private.txt`,
      404,
    )).arrayBuffer();
    expect(await expectHttpStatus(
      privateOwner.client,
      `/api/projects/${privateProject.project.id}/files/private.txt`,
      200,
    ).then((response) => response.text())).toBe(privateOwner.input);

    const restoredIdle = await waitForIdle(context.measure);
    const providerSummary = context.provider.requestSummary();
    expect(providerSummary.errors).toBe(0);
    expect(providerSummary.retries).toBe(0);
    semantic = semanticProjection(levels);
    await suite.report.json('capacity-v1.json', {
      contract: {
        levels: LEVELS,
        prompt: CAPACITY_PROMPT,
        repetitions: 2,
        version: 1,
        workload: ['provider', 'project', 'file', 'conversation', 'stream', 'tool', 'checkpoint', 'snapshot'],
      },
      errors: providerSummary.errors,
      levels,
      localOnly: true,
      restarts: 1,
      restoredIdle,
      retries: providerSummary.retries,
      semantic,
      unproven: [
        'Databricks Apps ingress, identity, compute, autoscaling, and admission capacity',
        'Unity Catalog persistence and production Gateway connectivity',
      ],
    });
  }, { idleEvictionMs: 2_000 });

  return { semantic, suite };
}

async function collectRunStream(
  client: HostedHttpClient,
  runId: string,
  requestedAt: number,
): Promise<StreamMetrics> {
  const response = await expectHttpStatus(client, `/api/runs/${runId}/events`, 200, {
    headers: { accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  if (reader == null) throw new Error(`run ${runId} returned no event stream`);
  const decoder = new TextDecoder();
  const frames: Array<{ at: number; data: unknown; event: string; id: string | null }> = [];
  let buffer = '';
  try {
    while (!frames.some((frame) => frame.event === 'end')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/u);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const parsed = parseSseFrame(part);
        if (parsed != null) frames.push({ ...parsed, at: performance.now() });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const events = frames.filter((frame) => frame.event !== 'heartbeat');
  const names = events.map((frame) => frame.event);
  expect(names[0]).toBe('start');
  expect(names.at(-1)).toBe('end');
  expect(names).not.toContain('error');
  expect(names.filter((event) => event === 'start')).toHaveLength(1);
  expect(names.filter((event) => event === 'end')).toHaveLength(1);
  const cursors = events.map((frame) => frame.id).filter((id): id is string => id != null);
  expect(new Set(cursors).size).toBe(cursors.length);
  const deltas = events.filter((frame) => (
    frame.event === 'agent'
    && typeof frame.data === 'object'
    && frame.data != null
    && (frame.data as { type?: unknown }).type === 'text_delta'
  ));
  expect(deltas.length).toBeGreaterThanOrEqual(2);
  const startedAt = events.find((frame) => frame.event === 'start')!.at;
  const endedAt = events.find((frame) => frame.event === 'end')!.at;
  const deltaTimes = deltas.map((frame) => frame.at);
  const metrics = {
    durationMs: endedAt - requestedAt,
    eventCounts: Object.fromEntries([...new Set(names)].map((name) => [
      name,
      names.filter((candidate) => candidate === name).length,
    ])),
    firstTokenMs: deltaTimes[0]! - requestedAt,
    queueWaitMs: startedAt - requestedAt,
    streamGapsMs: deltaTimes.slice(1).map((at, index) => at - deltaTimes[index]!),
    text: deltas.map((frame) => (frame.data as { delta: string }).delta).join(''),
  };
  for (const value of [
    metrics.durationMs,
    metrics.firstTokenMs,
    metrics.queueWaitMs,
    ...metrics.streamGapsMs,
  ]) expect(value).toBeGreaterThanOrEqual(0);
  return metrics;
}

function parseSseFrame(value: string): { data: unknown; event: string; id: string | null } | null {
  const lines = value.split(/\r?\n/u);
  if (lines.every((line) => line === '' || line.startsWith(':'))) return null;
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
  if (event == null) return null;
  const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
  return {
    data: data === '' ? null : JSON.parse(data),
    event,
    id: lines.find((line) => line.startsWith('id: '))?.slice(4) ?? null,
  };
}

async function waitForIdle(measure: () => Promise<HostedMeasurement>): Promise<HostedMeasurement> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const measurement = await measure();
    if (isIdle(measurement)) {
      expectIdle(measurement);
      return measurement;
    }
    await delay(100);
  }
  throw new Error('hosted capacity resources did not return to idle');
}

function isIdle(measurement: HostedMeasurement): boolean {
  const registry = measurement.registry;
  return measurement.process.childCurrent === 0
    && registry.residentRuntimes === 0
    && registry.activeChildren === 0
    && registry.queuedMutations === 0
    && registry.strongLeases === 0
    && registry.weakLeases === 0
    && registry.activeRuns === 0
    && registry.laneOperations === 0
    && registry.openDatabases === 0
    && Object.values(registry.eventBudget).every((value) => value === 0);
}

function expectIdle(measurement: HostedMeasurement): void {
  expect(isIdle(measurement)).toBe(true);
  expect(measurement.process.activeResources.byType.FSEventWrap ?? 0).toBe(0);
  expect(measurement.process.activeResources.byType.StatWatcher ?? 0).toBe(0);
  for (const value of [
    measurement.process.cpuUserMicros,
    measurement.process.cpuSystemMicros,
    measurement.process.rssBytes,
    measurement.process.heapUsedBytes,
    measurement.process.heapTotalBytes,
    measurement.process.eventLoopUtilization,
    measurement.process.eventLoopLagMs.mean,
    measurement.process.eventLoopLagMs.max,
    measurement.process.eventLoopLagMs.p99,
    measurement.process.synchronousBlockingMs,
  ]) expect(Number.isFinite(value)).toBe(true);
}

function semanticProjection(levels: Array<Record<string, unknown>>): unknown {
  return levels.map((level) => ({
    admittedUsers: level.admittedUsers,
    operationKinds: [...new Set(
      (level.operations as Array<{ kind: string }>).map((operation) => operation.kind),
    )].sort(),
    provider: level.provider,
    users: (level.users as Array<{
      eventCounts: Record<string, number>;
      identity: HostedCapacityIdentity;
      status: string;
    }>).map((user) => ({
      eventCounts: user.eventCounts,
      identity: user.identity,
      status: user.status,
    })),
  }));
}

async function capacityStep<T>(
  identity: HostedCapacityIdentity,
  step: string,
  work: Promise<T>,
): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new Error(`capacity ${identity} ${step} failed`, { cause: error });
  }
}
