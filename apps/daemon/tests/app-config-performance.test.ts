import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppConfig, writeAppConfig } from '../src/app-config.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'readable-performance-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('performance profile persistence', () => {
  it('returns full when no preference exists', async () => {
    // Given an empty data directory.
    // When preferences are read.
    const config = await readAppConfig(dataDir);
    // Then the default is explicit.
    expect(config).toHaveProperty('performanceProfile', 'full');
  });

  it.each(['full', 'low'])('round-trips %s when explicitly selected', async (profile) => {
    // Given unrelated saved preferences.
    await writeAppConfig(dataDir, { agentId: 'claude', skillId: 'coder' });
    // When a profile is selected.
    const written = await writeAppConfig(dataDir, { performanceProfile: profile, rogue: true });
    // Then write, disk, and read agree without losing preferences or admitting unknown keys.
    const expected = { performanceProfile: profile, agentId: 'claude', skillId: 'coder' };
    expect(written).toMatchObject(expected);
    expect(await readAppConfig(dataDir)).toMatchObject(expected);
    expect(JSON.parse(await readFile(path.join(dataDir, 'app-config.json'), 'utf8'))).toMatchObject(expected);
    expect(written).not.toHaveProperty('rogue');
  });

  it.each(['auto', 'LOW', '', true, 1, {}, []].map((profile) => ({ profile })))('rejects $profile without changing even a migration-eligible file', async ({ profile }) => {
    // Given legacy preferences whose read would trigger an agent-history migration.
    const file = path.join(dataDir, 'app-config.json');
    const original = JSON.stringify({ performanceProfile: 'low', enabledAgentIds: [], agentId: 'claude' });
    await writeFile(file, original);
    // When an invalid profile arrives with another otherwise valid change.
    const result = writeAppConfig(dataDir, { performanceProfile: profile, agentId: 'codex' });
    // Then validation rejects the complete update before any disk mutation.
    await expect(result).rejects.toMatchObject({ name: 'InvalidAppConfigError', code: 'VALIDATION_FAILED' });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('restores full when the selected profile is unset', async () => {
    // Given a saved low profile.
    await writeAppConfig(dataDir, { performanceProfile: 'low', agentId: 'claude' });
    // When the generic config reset sentinel is sent.
    const written = await writeAppConfig(dataDir, { performanceProfile: null });
    // Then the effective and persisted profile is full.
    expect(written).toMatchObject({ performanceProfile: 'full', agentId: 'claude' });
    expect(await readAppConfig(dataDir)).toHaveProperty('performanceProfile', 'full');
  });

  it('preserves low when an unrelated preference changes', async () => {
    // Given a saved low profile.
    await writeAppConfig(dataDir, { performanceProfile: 'low' });
    // When a different key is updated.
    const written = await writeAppConfig(dataDir, { skillId: 'coder' });
    // Then merging retains the explicit profile.
    expect(written).toMatchObject({ performanceProfile: 'low', skillId: 'coder' });
  });
});
