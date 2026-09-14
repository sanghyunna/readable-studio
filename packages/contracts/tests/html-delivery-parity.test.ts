import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (side: 'daemon' | 'contracts', name: string) => readFileSync(new URL(
  side === 'daemon' ? `../../../apps/daemon/src/prompts/${name}.ts` : `../src/prompts/${name}.ts`,
  import.meta.url,
), 'utf8');
const section = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  // JavaScript template literals normalize CRLF to LF in the shipped string.
  return text.slice(from, to).replace(/\r\n/g, '\n');
};

describe('HTML delivery shipped-copy parity', () => {
  it('ships identical deck source apart from contracts source-map annotations', () => {
    const stripAnnotations = (text: string) => text.replace(/^\/\/ @dsp .*\n/gm, '');
    expect(stripAnnotations(source('contracts', 'deck-framework'))).toBe(stripAnnotations(source('daemon', 'deck-framework')));
  });

  it.each([
    ['official-system', '4. **Build', '## Document format'],
    ['discovery', '## Delivery', '## RULE 3'],
    ['system', 'const API_MODE_OVERRIDE =', 'const CHAT_MODE_OVERRIDE ='],
  ])('ships identical delivery section in %s', (name, start, end) => {
    expect(section(source('contracts', name!), start!, end!)).toBe(section(source('daemon', name!), start!, end!));
  });

  it('uses the preview entry as the report example identifier', () => {
    const skill = readFileSync(new URL('../../../plugins/_official/examples/example-report/SKILL.md', import.meta.url), 'utf8');
    const entry = skill.match(/^    entry: (.+)$/m)?.[1];
    expect(entry).toBe('index.html');
    const artifacts = [...skill.matchAll(/<artifact\s+identifier="([^"]+)"\s+type="([^"]+)"\s+title="([^"]+)"/g)];
    expect(artifacts).toHaveLength(1);
    expect(`${artifacts[0]![1]}.html`).toBe(entry);
    expect(artifacts[0]![2]).toBe('text/html');
    expect(artifacts[0]![3]).not.toBe(artifacts[0]![1]);
  });
});
