import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalProfilesConfig = process.env.READABLE_AGENT_PROFILES_CONFIG;

afterEach(() => {
  if (originalProfilesConfig === undefined) {
    delete process.env.READABLE_AGENT_PROFILES_CONFIG;
  } else {
    process.env.READABLE_AGENT_PROFILES_CONFIG = originalProfilesConfig;
  }
  vi.resetModules();
});

describe('default enabled agent registry', () => {
  it('equals the canonical registry ids in registry order', async () => {
    const { AGENT_DEFS, DEFAULT_ENABLED_AGENT_IDS } = await import(
      '../../src/runtimes/registry.js'
    );

    expect(DEFAULT_ENABLED_AGENT_IDS).toEqual(
      AGENT_DEFS.map((agent) => agent.id),
    );
  });

  it('includes local profiles available at daemon process startup', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'readable-agent-defaults-'));
    try {
      const profilesFile = path.join(root, 'agents.local.json');
      writeFileSync(
        profilesFile,
        JSON.stringify({
          agents: [{ id: 'local-startup-agent', baseAgent: 'claude' }],
        }),
      );
      process.env.READABLE_AGENT_PROFILES_CONFIG = profilesFile;
      vi.resetModules();

      const { AGENT_DEFS, DEFAULT_ENABLED_AGENT_IDS } = await import(
        '../../src/runtimes/registry.js'
      );

      expect(AGENT_DEFS.map((agent) => agent.id)).toContain(
        'local-startup-agent',
      );
      expect(DEFAULT_ENABLED_AGENT_IDS).toContain('local-startup-agent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
