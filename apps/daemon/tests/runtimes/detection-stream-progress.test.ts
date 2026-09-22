import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DetectedAgent, RuntimeAgentDef } from '../../src/runtimes/types.js';
vi.mock('../../src/runtimes/registry.js', () => ({
  AGENT_DEFS: ['codex', 'kimi'].map((id): RuntimeAgentDef => ({
    id, name: id, bin: process.execPath, versionArgs: ['--version'],
    fallbackModels: [], buildArgs: () => [], streamFormat: 'plain',
  })),
  DEFAULT_ENABLED_AGENT_IDS: ['codex', 'kimi'],
}));
vi.mock('../../src/runtimes/detection-probe.js', async (original) => ({
  ...await original<typeof import('../../src/runtimes/detection-probe.js')>(), safeProbe: vi.fn(),
}));
import { safeProbe } from '../../src/runtimes/detection-probe.js';
import * as detection from '../../src/runtimes/detection.js';

let root: string | undefined;
afterEach(async () => {
  detection._resetAgentDetectionCacheForTests();
  if (root) await rm(root, { recursive: true, force: true });
});
function result(def: RuntimeAgentDef): DetectedAgent {
  return { ...def, available: false, models: [], modelsSource: 'live' };
}

it('streams a completed durable probe before a slow peer finishes', async () => {
  // Given durable storage and one slow probe.
  root = await mkdtemp(path.join(tmpdir(), 'scan-stream-'));
  detection.configureDetectionStorage(root);
  let releaseSlow = () => {};
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let finishFast = () => {};
  const fastFinished = new Promise<void>((resolve) => { finishFast = resolve; });
  vi.mocked(safeProbe).mockImplementation(async (def) => {
    if (def.id === 'kimi') await slow;
    else finishFast();
    return result(def);
  });
  const stream = detection.detectAgentsStream({}, { enabledAgentIds: ['codex', 'kimi'], signal: AbortSignal.timeout(4000) });
  // When the fast probe finishes while its peer is held.
  const first = stream.next();
  await fastFinished;
  try {
    // Then the stream yields without requiring the slow probe's release.
    const next = await first;
    expect(next.value).toMatchObject({ id: 'codex' });
    expect(detection.getStartupScanProgress()).toMatchObject({ phase: 'running', completed: 1, total: 2 });
  } finally {
    releaseSlow();
    while (!(await stream.next()).done) { /* Drain persistence completion. */ }
  }
});
