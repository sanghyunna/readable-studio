import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cachedSafeProbe, _resetAgentDetectionCacheForTests } from '../../src/runtimes/detection-cache.js';
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import { minimalAgentDef } from './helpers/test-helpers.js';

beforeEach(() => {
  _resetAgentDetectionCacheForTests();
  vi.stubEnv('KIMI_BIN', process.execPath);
});
afterEach(() => vi.unstubAllEnvs());
const def = minimalAgentDef({ id: 'kimi', bin: 'node',
  modelDiscovery: 'authenticated-session',
  fetchModels: async () => [{ id: 'verified', label: 'Verified' }],
});

it('verifies models when the daemon inherited the packaged offline flag', async () => {
  // Given a working CLI under the old daemon-lifetime policy.
  vi.stubEnv('READABLE_AGENT_DISCOVERY_OFFLINE', '1');
  // When a normal request probes it.
  const agent = await safeProbe(def);
  // Then only verified live models are selectable.
  expect(agent).toMatchObject({ available: true, modelsSource: 'live', models: [{ id: 'verified' }] });
});

it('keeps an explicitly offline request unverified', async () => {
  // Given a working CLI.
  // When discovery is deliberately restricted for this request.
  const agent = await safeProbe(def, {}, 'offline');
  // Then it cannot claim usability.
  expect(agent).toMatchObject({ available: false, models: [] });
});

it('always verifies when refresh overrides an offline request and inherited flag', async () => {
  // Given a daemon started offline.
  vi.stubEnv('READABLE_AGENT_DISCOVERY_OFFLINE', '1');
  // When an explicit rescan is requested.
  const agent = await cachedSafeProbe(safeProbe, def, {}, { policy: 'offline', refresh: true });
  // Then verification wins over the cold-start policy.
  expect(agent).toMatchObject({ available: true, models: [{ id: 'verified' }] });
});

it('separates cached and in-flight results when policies differ', async () => {
  // Given an offline probe whose version process is still in flight.
  const offline = cachedSafeProbe(safeProbe, def, {}, { policy: 'offline' });
  // When an online consumer arrives before settlement.
  const online = cachedSafeProbe(safeProbe, def, {}, { policy: 'online' });
  const results = await Promise.all([offline, online]);
  // Then neither the in-flight nor settled result crosses policy boundaries.
  expect(online).not.toBe(offline);
  expect(results.map((agent) => agent.available)).toEqual([false, true]);
  expect((await cachedSafeProbe(safeProbe, def, {}, { policy: 'offline' })).available).toBe(false);
  expect((await cachedSafeProbe(safeProbe, def, {}, { policy: 'online' })).available).toBe(true);
});
