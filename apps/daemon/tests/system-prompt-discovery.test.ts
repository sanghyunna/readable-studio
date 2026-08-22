import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/prompts/system.js';

describe('composeSystemPrompt discovery controls', () => {
  it('pins the API batch-mode discovery skip before the normal discovery rules', () => {
    const out = composeSystemPrompt({
      metadata: {
        kind: 'prototype',
        skipDiscoveryBrief: true,
      },
    });

    const overrideIdx = out.indexOf('Automated project mode — skip discovery form');
    const discoveryIdx = out.indexOf('# Readable Studio core directives');
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    expect(discoveryIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeLessThan(discoveryIdx);
    expect(out).toMatch(/do NOT emit `<question-form id="discovery">`/);
  });

  it('does not instruct agents to ask for a second visual-direction picker', () => {
    const out = composeSystemPrompt({
      metadata: { kind: 'prototype' },
      designSystemBody: '# Brand\n\nUse brand tokens.',
      designSystemTitle: 'Brand',
    });

    expect(out).toContain('Do not emit a direction question-form');
    expect(out).not.toContain('<question-form id="direction"');
    expect(out).not.toContain('Pick a visual direction');
    expect(out).toContain('if a design system is active and no new brand/reference source was provided, use it as the visual direction without asking again');
  });


});
