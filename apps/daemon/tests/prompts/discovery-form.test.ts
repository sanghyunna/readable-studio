import { describe, expect, it } from 'vitest';
import { DISCOVERY_AND_PHILOSOPHY } from '../../src/prompts/discovery.js';

describe('discovery assumption-receipt arc', () => {
  it('starts work on turn 1 instead of mandating a discovery form', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('## RULE 1 — turn 1 declares an assumption receipt and starts work');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('Immediately call TodoWrite, then begin the junior-pass wireframe in the same turn');
    expect(DISCOVERY_AND_PHILOSOPHY).not.toContain('turn 1 must emit a `<question-form id="discovery">`');
    expect(DISCOVERY_AND_PHILOSOPHY).not.toContain('The form **applies** even when');
  });

  it('declares all core assumptions with explicit provenance', () => {
    for (const id of ['output', 'platform', 'audience', 'tone', 'brand', 'scale', 'constraints']) {
      expect(DISCOVERY_AND_PHILOSOPHY).toContain(`"id": "${id}"`);
    }
    for (const provenance of ['stated', 'inferred', 'default']) {
      expect(DISCOVERY_AND_PHILOSOPHY).toContain(`"provenance": "${provenance}"`);
    }
  });

  it('keeps question forms for genuinely blocking asks', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('<question-form id="brand-source"');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('plugin-required input with no valid default');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('destructive confirmation');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('emit the blocking `brand-source` form above and stop');
  });

  it('routes mid-generation corrections without restarting discovery', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('[brief correction — …]');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('steer the work already in progress');
  });
});
