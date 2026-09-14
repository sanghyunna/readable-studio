import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORM_ANSWERED_SYSTEM_OVERRIDE } from '../../src/server.js';
import { composeSystemPrompt } from '../../src/prompts/system.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const noFileChannel = /<readable-delivery channel="no-file-tools">[\s\S]*?<\/readable-delivery>/g;
const artifact = /<artifact\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
function htmlExamples(text: string) {
  return [...text.matchAll(artifact)].map(match => Object.fromEntries(
    [...match[1]!.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)]
      .map(attribute => [attribute[1]!, attribute[2] ?? attribute[3]]),
  )).filter(attributes => attributes.type === 'text/html');
}

// The delimiters are lint-consumed branch sentinels, not pinned prose. A new
// HTML transport example must be scoped to the no-file-tools branch.
function violations(text: string): string[] {
  const errors: string[] = [];
  const fileBacked = text.replace(noFileChannel, '');
  if (htmlExamples(fileBacked).length) errors.push('file-backed-artifact');
  for (const attributes of htmlExamples(text)) {
    if (attributes.identifier !== 'index') errors.push('unstable-identifier');
    if (!attributes.title || attributes.title === attributes.identifier) errors.push('invalid-metadata');
  }
  return errors;
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

describe('single-delivery prompt surface guard', () => {
  it('rejects an unscoped transport example and a topic-derived identifier', () => {
    const example = '<artifact identifier="index" type="text/html" title="TITLE_SENTINEL">';
    expect(violations(example)).toEqual(['file-backed-artifact']);
    expect(violations(`<readable-delivery channel="no-file-tools">${example.replace('identifier="index"', 'identifier="topic-slug"')}</readable-delivery>`)).toEqual(['unstable-identifier']);
    expect(violations(`<readable-delivery channel="no-file-tools"><artifact title='TITLE_SENTINEL' type='text/html' identifier='topic-slug'></readable-delivery>`)).toEqual(['unstable-identifier']);
  });

  it('scopes every shipped skill/template HTML example to the tool-less branch', () => {
    const files = ['skills', 'design-templates', 'plugins', 'craft'].flatMap(name => markdownFiles(resolve(root, name)));
    let examples = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      examples += htmlExamples(text).length;
      expect(violations(text), path).toEqual([]);
    }
    expect(examples).toBeGreaterThan(0);
  });

  it('keeps the HTML transport example in the dedicated policy renderer on both prompt trees', () => {
    for (const directory of ['apps/daemon/src/prompts', 'packages/contracts/src/prompts']) {
      for (const entry of readdirSync(resolve(root, directory))) {
        if (!entry.endsWith('.ts') || entry === 'html-output-policy.ts') continue;
        const path = resolve(root, directory, entry);
        // Critique Theater's uppercase ARTIFACT/mime protocol is distinct from
        // the project-chat artifact/type transport and is intentionally intact.
        expect(htmlExamples(readFileSync(path, 'utf8')), path).toEqual([]);
      }
    }
  });

  it('keeps answered-form completion on the selected delivery branch', () => {
    expect(violations(FORM_ANSWERED_SYSTEM_OVERRIDE)).toEqual([]);
    expect(htmlExamples(FORM_ANSWERED_SYSTEM_OVERRIDE).map(attributes => attributes.identifier)).toEqual(['index']);
    expect(FORM_ANSWERED_SYSTEM_OVERRIDE.replace(noFileChannel, '')).not.toMatch(/<artifact\b/);
    for (const streamFormat of [undefined, 'plain']) {
      const prompt = composeSystemPrompt({ streamFormat }) + FORM_ANSWERED_SYSTEM_OVERRIDE;
      const policy = JSON.parse(prompt.match(/<readable-html-output-policy>(.*?)<\/readable-html-output-policy>/)![1]!);
      expect(policy.delivery).toBe(streamFormat === 'plain' ? 'artifact' : 'file');
      expect(policy.fileBackedHandoff).toBe('summary-only');
    }
  });
});
