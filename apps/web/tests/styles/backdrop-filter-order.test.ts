import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const stylesDirectory = fileURLToPath(new URL('../../src/styles/', import.meta.url));

function prefixOrderViolations(relativePath: string): readonly string[] {
  const source = readFileSync(new URL(`../../src/styles/${relativePath}`, import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/);
  const violations: string[] = [];

  for (const [index, line] of lines.entries()) {
    const declaration = /^\s*backdrop-filter:\s*(.+);\s*$/.exec(line);
    if (declaration === null) continue;

    const expectedPrefix = `-webkit-backdrop-filter: ${declaration[1]};`;
    if (lines[index - 1]?.trim() !== expectedPrefix) {
      violations.push(`${relativePath}:${index + 1}`);
    }
  }

  return violations;
}

describe('backdrop-filter authoring contract', () => {
  it('authors a matching webkit prefix immediately before every unprefixed declaration', () => {
    const violations = readdirSync(stylesDirectory, { encoding: 'utf8', recursive: true })
      .filter((relativePath) => relativePath.endsWith('.css'))
      .sort()
      .flatMap(prefixOrderViolations);

    expect(violations).toEqual([]);
  });
});
