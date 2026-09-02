import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const memoryCss = readFileSync(
  new URL('../../src/styles/viewer/memory.css', import.meta.url),
  'utf8',
);
const libraryCss = readFileSync(
  new URL('../../src/styles/viewer/library.css', import.meta.url),
  'utf8',
);
const todoToolSources = [
  '../../src/components/AssistantMessage.tsx',
  '../../src/components/ToolCard.tsx',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

describe('checkbox residue cleanup CSS', () => {
  it('removes legacy checkbox switch rules while preserving current layout selectors', () => {
    // Given
    const ownedCss = `${memoryCss}\n${libraryCss}`;

    // When
    const legacyCheckboxSelectors = [
      /input\s*\[\s*type\s*=\s*["']?checkbox["']?\s*\]/u,
      /:checked/u,
      /\.toggle-switch(?:-sm)?\b/u,
      /\.toggle-slider\b/u,
    ];

    // Then
    for (const selector of legacyCheckboxSelectors) {
      expect(ownedCss).not.toMatch(selector);
    }
    expect(todoToolSources).not.toMatch(/[☐☑☒]/u);
    expect(memoryCss).toContain('.manual-edit-workspace');
    expect(libraryCss).toContain('.library-ds-toggle-cell');
    expect(libraryCss).toContain('.library-preview');
  });
});
