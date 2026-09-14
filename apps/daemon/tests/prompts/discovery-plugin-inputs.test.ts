import { describe, expect, it } from 'vitest';
import { DISCOVERY_AND_PHILOSOPHY } from '../../src/prompts/discovery.js';
import { composeSystemPrompt } from '../../src/prompts/system.js';

describe('discovery assumption sources', () => {
  it('treats project metadata and plugin inputs as stated facts', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('Project metadata and plugin inputs are authoritative stated values');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('active plugin inputs');
  });

  it('maps semantically equivalent input names into the receipt', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('`artifactKind`/`mode`/`taskKind` → output');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('`surface`/`platformTargets`/`target` → platform');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('`slideCount`/`slides`/`pageCount` → scale');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('`designSystem` → brand');
  });

  it.each(['prototype', 'deck', 'template', 'other'])(
    'does not turn missing preference metadata back into questions (%s)',
    kind => {
      const preferences = {
        platform: 'desktop',
        fidelity: 'wireframe',
        slideCount: '8',
        speakerNotes: false,
        animations: false,
      };
      // Exercise the real composer, not the wording of its discovery guidance.
      // Supplied values are the positive control: removing metadata rendering
      // entirely must not make the missing-value assertions pass vacuously.
      for (const values of [
        {},
        Object.fromEntries(Object.keys(preferences).map(key => [key, null])),
        preferences,
      ]) {
        const prompt = composeSystemPrompt({ metadata: { kind, ...values } });
        const block = prompt.match(/\n## Project metadata\n([\s\S]*?)(?=\n(?:## |---)|$)/)?.[1];
        expect(block).toBeDefined();
        const fields = Object.fromEntries(
          [...block!.matchAll(/^- \*\*(\w+)\*\*: (.*)$/gm)].map(([, key, value]) => [key, value]),
        );
        expect(fields).toEqual(values === preferences
          ? { kind, ...Object.fromEntries(Object.entries(preferences).map(([key, value]) => [key, String(value)])) }
          : { kind });
        expect(block).not.toMatch(/<(?:question-form|ask-question)\b/);
      }
    },
  );
});
