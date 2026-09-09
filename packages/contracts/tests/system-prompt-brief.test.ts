import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/prompts/system.js';

describe('saved question context', () => {
  it('renders existing brief-only values without labels or arbitrary receipt fields', () => {
    const prompt = composeSystemPrompt({ metadata: { kind: 'prototype', brief: { updatedAt: 1, assumptions: [
      { id: 'audience', label: 'IGNORED_LABEL_729', value: 'INTAKE_READER_729', provenance: 'stated' },
      { id: 'constraints', label: 'Constraints', value: ['CONSTRAINT_729_A', 'CONSTRAINT_729_B'], provenance: 'inferred' },
      { id: 'unknown', label: 'Unknown', value: 'IGNORED_FIELD_729', provenance: 'default' },
    ] } } });
    expect(prompt.split('INTAKE_READER_729')).toHaveLength(2);
    expect(prompt).toContain('CONSTRAINT_729_A');
    expect(prompt).toContain('CONSTRAINT_729_B');
    expect(prompt).not.toContain('IGNORED_LABEL_729');
    expect(prompt).not.toContain('IGNORED_FIELD_729');
  });
});
