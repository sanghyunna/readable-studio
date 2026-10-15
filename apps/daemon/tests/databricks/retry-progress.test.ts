import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { withDeadline } from '../../src/databricks/client.js';
import { createDatabricksService } from '../../src/databricks/service.js';
import { startDatabricksPiSession } from '../../src/runtimes/pi-databricks.js';
import { createPiTurnFixture, fixtureCliRunner, fixtureNow } from './pi-turn-fixture.js';
import { protocolFixture } from './runtime-fixture.js';

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: async (_ms: number, _value: unknown, options: { signal: AbortSignal }) => {
    options.signal.throwIfAborted();
  },
}));

test('concurrent managed runs receive only their own relay retry counts and clear on success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'databricks-retry-progress-'));
  const fixture = await createPiTurnFixture();
  const turns: Array<Awaited<ReturnType<typeof startDatabricksPiSession>>> = [];
  try {
    const cwd = path.join(root, 'project');
    await mkdir(cwd);
    const service = createDatabricksService({
      dataRoot: root, now: () => fixtureNow, fetch: fixture.fetch,
      clientOptions: { runner: fixtureCliRunner, resolveExecutable: async () => 'fixture-databricks.exe' },
      resolveResource: async () => protocolFixture('anthropic-messages').request.body.model,
    });
    const profiles = await service.probe();
    const found = await service.lookup({
      profileId: profiles.profiles[0]!.id, resourceId: 'fixture-resource', kind: 'uc-model-service',
    });
    const registered = await service.enable(found.endpoint.id, {
      scanId: found.scanId, expectedRevision: found.revision,
    });
    const events = [[], []] as Array<Array<{ channel: string; payload: Record<string, unknown> }>>;
    const retries = [3, 1];
    await Promise.all(retries.map(async (limit, index) => {
      let attempts = 0;
      const retryFetch: typeof fetch = async (input, init) => {
        if (++attempts <= limit) return new Response('rate-limited', { status: 429 });
        return fixture.fetch(input, init);
      };
      const turn = await startDatabricksPiSession({
        dataRoot: root, cwd, sessionKey: `retry-run-${index}`, model: registered.appModelId,
        reasoning: 'high', prompt: `Reply only OK for run ${index}.`, service, fetch: retryFetch,
        send: (channel, payload) => { events[index]!.push({ channel, payload }); },
      });
      turns.push(turn);
      await withDeadline(() => turn.completed, 25_000);
      expect(turn.session.hasFatalError()).toBe(false);
      const own = events[index]!;
      const progress = own.filter((event) => event.payload.label === 'retrying');
      expect(progress.map((event) => JSON.parse(String(event.payload.detail)))).toEqual(
        Array.from({ length: limit }, (_, n) => ({ provider: 'databricks', attempt: n + 1, maxRetries: 10, delayMs: 5000 })),
      );
      expect(progress.every((event) => event.channel === 'agent' && event.payload.type === 'status')).toBe(true);
      const cleared = own.findIndex((event) => event.payload.label === 'retry_complete');
      expect(cleared).toBeGreaterThan(own.findIndex((event) => event.payload.label === 'retrying'));
      expect(cleared).toBeLessThan(own.findIndex((event) => event.payload.type === 'text_delta'));
    }));
  } finally {
    for (const turn of turns) {
      if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill('SIGKILL');
    }
    await Promise.allSettled(turns.map((turn) => turn.completed));
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
