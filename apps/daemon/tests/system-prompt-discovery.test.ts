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
      designSystemBody: 'ACTIVE_DESIGN_SYSTEM_PAYLOAD_SENTINEL',
      designSystemTitle: 'Brand',
    });

    // The selected design-system payload survives composition, and the
    // shipped forms do not introduce a second direction-selection control.
    expect(out).toContain('ACTIVE_DESIGN_SYSTEM_PAYLOAD_SENTINEL');
    const forms = [...out.matchAll(/<question-form\s+id="([^"]+)"[^>]*>\s*({[\s\S]*?})\s*<\/question-form>/g)];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form[1]).not.toBe('direction');
      const body = JSON.parse(form[2]!);
      expect(body.questions.some((question: { type: string }) => question.type === 'direction-cards')).toBe(false);
    }
  });


});
