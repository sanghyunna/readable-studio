import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../..');

describe('daemon assumption-receipt localization rules', () => {
  it('localizes receipt and blocking-form user-facing copy without localizing ids', () => {
    const source = readFileSync(resolve(repoRoot, 'apps/daemon/src/prompts/discovery.ts'), 'utf8');
    expect(source).toContain("Match the user's chat language");
    expect(source).toContain("user-facing copy follows the user's language");
    expect(source).toContain('stable ids and option values stay in English');
  });
});
