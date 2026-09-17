import { beforeEach, expect, it, vi } from 'vitest';
import { cachedSafeProbe, _resetAgentDetectionCacheForTests } from '../../src/runtimes/detection-cache.js';
import type { DetectedAgent } from '../../src/runtimes/types.js';
import { minimalAgentDef } from './helpers/test-helpers.js';

beforeEach(_resetAgentDetectionCacheForTests);

for (const state of [
  { name: 'absent', available: false, models: [] },
  { name: 'unauthenticated', available: false, path: process.execPath, authStatus: 'missing', models: [] },
  { name: 'auth-unknown', available: false, path: process.execPath, authStatus: 'unknown', models: [] },
  { name: 'incompatible', available: false, path: process.execPath, models: [], diagnostics: [{ reason: 'not-executable', severity: 'error', message: 'fixture', fixActions: [] }] },
  { name: 'working', available: true, path: process.execPath, authStatus: 'ok', models: [{ id: 'verified', label: 'Verified' }] },
] satisfies Array<Partial<DetectedAgent> & { readonly name: string }>) {
  it(`preserves ${state.name} classification when concurrent refresh consumers join`, async () => {
    // Given a real classified result held at the shared probe boundary.
    const def = minimalAgentDef({ id: 'databricks', bin: '', modelManagement: 'databricks' });
    const result: DetectedAgent = { ...def, modelsSource: 'live', ...state };
    let complete: (agent: DetectedAgent) => void = () => { throw new Error('probe not started'); };
    const completion = new Promise<DetectedAgent>((resolve) => { complete = resolve; });
    const probe = vi.fn(() => completion);
    const warmup = cachedSafeProbe(probe, def);
    // When two concurrent refresh consumers join the ongoing probe.
    const consumers = [warmup, cachedSafeProbe(probe, def, {}, { refresh: true }), cachedSafeProbe(probe, def)];
    complete(result);
    // Then no classification or model availability is invented by caching.
    expect(await Promise.all(consumers)).toEqual([result, result, result]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
}

it('reads managed registrations again when the previous probe has settled', async () => {
  // Given a managed registry that was previously empty.
  const def = minimalAgentDef({ id: 'databricks', bin: '', modelManagement: 'databricks' });
  const empty: DetectedAgent = { ...def, available: false, models: [], modelsSource: 'live' };
  const configured: DetectedAgent = { ...empty, available: true, models: [{ id: 'new-registration', label: 'New' }] };
  const probe = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(configured);
  await cachedSafeProbe(probe, def);
  // When a subsequent consumer asks after a registration change.
  const result = await cachedSafeProbe(probe, def);
  // Then managed registrations remain immediately fresh.
  expect(result).toEqual(configured);
  expect(probe).toHaveBeenCalledTimes(2);
});
