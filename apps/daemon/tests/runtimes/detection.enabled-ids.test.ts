// detectAgents() filters capability results after scanning the complete registry.
// With no selection, every registered agent is enabled by default. The
// `cursor-agent` id must accept the legacy `agent` alias on disk via
// `fallbackBins`. Unknown ids must be ignored, duplicates collapsed,
// and aliases (`agent`, `cursor`) normalized to `cursor-agent`.

import { describe, expect, test, vi } from 'vitest';
import type { RuntimeAgentDef } from '../../src/runtimes/types.js';

vi.mock('../../src/runtimes/detection-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtimes/detection-probe.js')>();
  return {
    ...actual,
    // This suite tests registry selection, not installed CLIs or network readiness.
    safeProbe: async (def: RuntimeAgentDef) => ({ ...def, available: false, models: [], modelsSource: 'live' as const }),
  };
});

import { detectAgents } from '../../src/runtimes/detection.js';
import { shouldRunAgentNetworkDiscovery } from '../../src/runtimes/detection-probe.js';
import { AGENT_DEFS } from '../../src/runtimes/registry.js';
import { validateEnabledAgentIds } from '../../src/app-config.js';
import { DEFAULT_ENABLED_AGENT_IDS } from '../../src/runtimes/registry.js';

function ids(agents: { id: string }[]): string[] {
  return agents.map((a) => a.id).sort();
}

describe('packaged offline discovery', () => {
  test('skips only network-capable discovery probes when explicitly requested', () => {
    expect(shouldRunAgentNetworkDiscovery('offline')).toBe(false);
    expect(shouldRunAgentNetworkDiscovery()).toBe(true);
  });
});

describe('detectAgents enabledAgentIds filter', () => {
  test('returns the complete registry when no selection is persisted', async () => {
    // Given no persisted selection, when detection runs, then all adapters are offered.
    const agents = await detectAgents();
    expect(ids(agents)).toEqual(ids(AGENT_DEFS));
    expect(DEFAULT_ENABLED_AGENT_IDS).toEqual(AGENT_DEFS.map((agent) => agent.id));
  });

  test('enabledAgentIds: ["codex"] returns ONLY codex', async () => {
    const agents = await detectAgents({}, { enabledAgentIds: ['codex'] });
    expect(ids(agents)).toEqual(['codex']);
  });

  test('enabledAgentIds: ["cursor-agent"] returns ONLY cursor-agent', async () => {
    const agents = await detectAgents({}, { enabledAgentIds: ['cursor-agent'] });
    expect(ids(agents)).toEqual(['cursor-agent']);
  });

  test('enabledAgentIds: ["codex", "claude"] restricts returned capabilities', async () => {
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

  test('an explicit empty enabled set remains restrictive', () => {
    expect(validateEnabledAgentIds([])).toEqual([]);
  });
});
