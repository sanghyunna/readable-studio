import { describe, expect, it } from 'vitest';
import { DISCOVERY_AND_PHILOSOPHY } from '../../src/prompts/discovery.js';

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

  it('does not turn missing preference metadata back into questions', () => {
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('Resolve all applicable fields rather than omitting uncertainty');
    expect(DISCOVERY_AND_PHILOSOPHY).toContain('Never use a question form merely to collect preferences');
  });
});
