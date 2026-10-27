import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_DESIGNER_PROMPT } from '../../src/prompts/official-system.js';
import { composeSystemPrompt } from '../../src/prompts/system.js';

const contractSource = (name: string) => readFileSync(new URL(
  `../../../../packages/contracts/src/prompts/${name}.ts`, import.meta.url,
), 'utf8');
const daemonSystem = () => readFileSync(new URL('../../src/prompts/system.ts', import.meta.url), 'utf8');
const resourceRule = (text: string) => text.match(/2\. \*\*Explore provided resources\.\*\*[^\r\n]*/)?.[0];
const skillBody = 'Use assets/template.html, references/layouts.md, and references/checklist.md.';

describe('resource context continuity', () => {
  it('reuses current evidence while requiring missing or changed file contents and preferring file reads', () => {
    const rule = resourceRule(OFFICIAL_DESIGNER_PROMPT)!;
    expect(rule).toContain('Reuse file contents and tool results already available in the continuing conversation');
    expect(rule).toContain('when evidence is missing, the files may have changed, or the request needs more detail');
    expect(rule).toContain('do not restart completed inspection solely because a follow-up turn arrived');
    expect(rule).toContain('Prefer file read tools for text inspection');
    expect(rule).not.toContain('Use file-listing and read tools liberally');
  });

  it('keeps the seed pre-flight without forcing completed reads to restart on a follow-up', () => {
    const prompt = composeSystemPrompt({ skillMode: 'deck', skillBody });
    expect(prompt).toContain('Before writing code, read `assets/template.html`, `references/layouts.md`, `references/checklist.md`');
    expect(prompt).toContain('unless their current contents are already available in the continuing conversation');
    expect(prompt).toContain('read again when resources may have changed or needed detail is missing');
    expect(prompt).not.toContain('Pre-flight (do this before any other tool)');
  });

  it('applies the same evidence reuse rule to a selected template without weakening its style boundary', () => {
    const prompt = composeSystemPrompt({ templateReference: true, skillMode: 'deck', skillBody });
    expect(prompt).toContain('Use seed and layout contents already available in the continuing conversation for structure, style, and rendering mechanics only');
    expect(prompt).toContain('Read required resources when not yet inspected, when they may have changed, or when the current evidence is insufficient');
    expect(prompt).toContain('role="structure-and-visual-style-only"');
    expect(prompt).not.toContain('Pre-flight (do this before any other tool)');
  });

  it('keeps the workflow rule and readability base aligned with the contracts mirror', () => {
    expect(resourceRule(contractSource('official-system'))).toBe(resourceRule(OFFICIAL_DESIGNER_PROMPT));
    const contracts = contractSource('system');
    expect(contracts).toContain('unless their current contents are already available in the continuing conversation');
    expect(contracts).toContain('read again when resources may have changed or needed detail is missing');
    const readability = (source: string) => source.match(/const READABILITY_RULE_BASE = `[\s\S]*?`;/)?.[0]?.replace(/\r\n/g, '\n');
    expect(readability(daemonSystem())).toBeDefined();
    expect(readability(daemonSystem())).toBe(readability(contracts));
  });
});
