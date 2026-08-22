// RED spec: detectAgents() must filter the probed registry by an
// `enabledAgentIds` set so VDI cold start only pays for the agents the
// user has opted into. Default set is ['codex', 'cursor-agent'] (see
// DEFAULT_ENABLED_AGENT_IDS in apps/daemon/src/app-config.ts). The
// `cursor-agent` id must accept the legacy `agent` alias on disk via
// `fallbackBins`. Unknown ids must be ignored, duplicates collapsed,
// and aliases (`agent`, `cursor`) normalized to `cursor-agent`.

import { describe, expect, test } from 'vitest';

import { detectAgents } from '../../src/runtimes/detection.js';
import { shouldRunAgentNetworkDiscovery } from '../../src/runtimes/detection-probe.js';
import { AGENT_DEFS } from '../../src/runtimes/registry.js';
import {
  DEFAULT_ENABLED_AGENT_IDS,
  validateEnabledAgentIds,
} from '../../src/app-config.js';

function ids(agents: { id: string }[]): string[] {
  return agents.map((a) => a.id).sort();
}

describe('packaged offline discovery', () => {
  test('skips only network-capable discovery probes when explicitly requested', () => {
    expect(shouldRunAgentNetworkDiscovery({ READABLE_AGENT_DISCOVERY_OFFLINE: '1' })).toBe(false);
    expect(shouldRunAgentNetworkDiscovery({})).toBe(true);
  });
});

describe('detectAgents enabledAgentIds filter', () => {
  test('default (no options) probes only DEFAULT_ENABLED_AGENT_IDS', async () => {
    const agents = await detectAgents();
    expect(ids(agents)).toEqual([...DEFAULT_ENABLED_AGENT_IDS].sort());
    expect(agents.length).toBeLessThan(AGENT_DEFS.length);
  });

  test('enabledAgentIds: ["codex"] probes ONLY codex', async () => {
    const agents = await detectAgents({}, { enabledAgentIds: ['codex'] });
    expect(ids(agents)).toEqual(['codex']);
  });

  test('enabledAgentIds: ["cursor-agent"] probes ONLY cursor-agent', async () => {
    const agents = await detectAgents({}, { enabledAgentIds: ['cursor-agent'] });
    expect(ids(agents)).toEqual(['cursor-agent']);
  });

  test('enabledAgentIds: ["codex", "claude"] expands probed set beyond defaults', async () => {
    const agents = await detectAgents({}, { enabledAgentIds: ['codex', 'claude'] });
    expect(ids(agents)).toEqual(['claude', 'codex']);
  });

  test('unknown agent ids are ignored', async () => {
    const agents = await detectAgents(
      {},
      { enabledAgentIds: ['codex', 'definitely-not-a-real-agent-id'] },
    );
    expect(ids(agents)).toEqual(['codex']);
  });

  test('validateEnabledAgentIds collapses duplicates and normalizes aliases', () => {
    expect(validateEnabledAgentIds(['agent', 'cursor', 'cursor-agent'])).toEqual([
      'cursor-agent',
    ]);
    expect(validateEnabledAgentIds(['codex', 'codex', 'CODEX'])).toEqual(['codex']);
  });

  test('cursor-agent definition exposes "agent" as a fallback bin', () => {
    const def = AGENT_DEFS.find((d) => d.id === 'cursor-agent');
    expect(def, 'cursor-agent must be registered').toBeDefined();
    expect(def?.fallbackBins).toBeDefined();
    expect(def?.fallbackBins).toContain('agent');
  });

  test('DEFAULT_ENABLED_AGENT_IDS is exactly [codex, cursor-agent]', () => {
    expect([...DEFAULT_ENABLED_AGENT_IDS].sort()).toEqual(
      ['codex', 'cursor-agent'].sort(),
    );
  });
});
