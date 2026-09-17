import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'scan-config-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(['.readable-studio', 'ReadableStudioData/namespaces/test'])('persists completion in the supplied %s data root', async (relative) => {
  // Given
  const dataDir = path.join(root, relative);
  const marker = { completedAt: '2026-09-17T00:00:00.000Z', agentIds: ['codex'] };
  // When
  await writeAppConfig(dataDir, { agentScan: marker });
  // Then
  expect(await readAppConfig(dataDir)).toHaveProperty('agentScan', marker);
  expect(await readAppConfig(path.join(root, 'other'))).not.toHaveProperty('agentScan');
});

it.each([{}, { completedAt: 'invalid', agentIds: ['codex'] }, { completedAt: '2026-09-17T00:00:00Z', agentIds: [4] }])('rejects incomplete marker %j', async (marker) => {
  // Given
  const dataDir = path.join(root, 'data');
  // When
  await writeAppConfig(dataDir, { agentScan: marker });
  // Then
  expect(await readAppConfig(dataDir)).not.toHaveProperty('agentScan');
});
