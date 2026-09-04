import { describe, expect, it } from 'vitest';

import { dedupeAgentModels } from '../../src/components/modelCatalog';

// The exact list the daemon ships for Claude Code (runtimes/defs/claude.ts),
// which is what the user's screenshot showed as a duplicated flat list.
const CLAUDE_RAW = [
  { id: 'default', label: 'Default (CLI config)' },
  { id: 'fable', label: 'Fable (alias)' },
  { id: 'claude-fable-5', label: 'claude-fable-5' },
  { id: 'sonnet', label: 'Sonnet (alias)' },
  { id: 'opus', label: 'Opus (alias)' },
  { id: 'haiku', label: 'Haiku (alias)' },
  { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
  { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
];

describe('dedupeAgentModels', () => {
  it('collapses every alias/id pair into one entry', () => {
    const out = dedupeAgentModels(CLAUDE_RAW);
    expect(out.map((m) => m.id)).toEqual([
      'default',
      'claude-fable-5',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
    ]);
  });

  it('presents clean names with no "(alias)" noise', () => {
    const out = dedupeAgentModels(CLAUDE_RAW);
    expect(out.map((m) => m.label)).toEqual([
      'Default',
      'Fable',
      'Sonnet',
      'Opus',
      'Haiku',
    ]);
  });

  it('contains no duplicate alias/id pair', () => {
    const out = dedupeAgentModels(CLAUDE_RAW);
    // No entry may be a bare alias token of another entry.
    for (const a of out) {
      for (const b of out) {
        if (a.id === b.id) continue;
        expect(b.id.toLowerCase().split(/[-_/]/)).not.toContain(a.id.toLowerCase());
      }
    }
    expect(new Set(out.map((m) => m.id)).size).toBe(out.length);
  });

  it('keeps the canonical id as the executed value', () => {
    const out = dedupeAgentModels(CLAUDE_RAW);
    // "Sonnet" must run claude-sonnet-4-5, not the bare alias.
    expect(out.find((m) => m.label === 'Sonnet')?.id).toBe('claude-sonnet-4-5');
  });

  it('passes through catalogues that have no alias pairs', () => {
    const codex = [
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'gpt-5-codex', label: 'gpt-5-codex' },
      { id: 'o3', label: 'o3' },
    ];
    expect(dedupeAgentModels(codex).map((m) => m.id)).toEqual([
      'default',
      'gpt-5-codex',
      'o3',
    ]);
  });

  it('is a no-op on an empty list', () => {
    expect(dedupeAgentModels([])).toEqual([]);
  });
});
