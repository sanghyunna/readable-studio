import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';

const fidelity = {
  factSources: ['user-request', 'user-attachments'],
  outsideFacts: 'forbidden',
  suppliedFacts: 'preserve-all-verbatim',
  unsuppliedFields: 'omit',
};

describe('document fact fidelity sentinel', () => {
  it.each([false, true])('protects supplied facts for template=%s', (templateReference) => {
    const prompt = composeSystemPrompt({ templateReference });
    const match = prompt.match(/<readable-fact-fidelity>(.*?)<\/readable-fact-fidelity>/s);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(fidelity);
    if (templateReference) {
      const gate = prompt.match(/<readable-template-content-gate>(.*?)<\/readable-template-content-gate>/s)!;
      expect(JSON.parse(gate[1]!).factFidelity).toEqual(fidelity);
    }
  });
});
