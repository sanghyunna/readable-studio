import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@readable-studio/contracts';
import { examplePresetSeedPrompt } from '../../src/components/plugins-home/presetSeedPrompt';
import { composeTemplatePrompt, templatePromptBoundary, userTextFromTemplateMessage } from '../../src/components/home-hero/templatePrompt';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const files = execFileSync('fd', ['--absolute-path', '--type', 'f', '--glob', 'readable-studio.json', path.join(root, 'plugins/_official/examples')], {
  encoding: 'utf8', windowsHide: true,
}).trim().split(/\r?\n/).filter(Boolean).sort();
const user = 'USER_CONTENT_723: Cedar Library has 320 participants, 18 tutors, and 7 workshops.';

describe('all shipped hidden template submissions', () => {
  it('discovers the complete catalogue rather than a handpicked fixture list', () => {
    expect(files.length).toBeGreaterThan(140);
  });
  it.each(files.map((file) => [path.basename(path.dirname(file)), file]))('%s keeps catalogue material out of the user content source', (_slug, file) => {
    const manifest = JSON.parse(readFileSync(file!, 'utf8')) as InstalledPluginRecord['manifest'];
    const record: InstalledPluginRecord = {
      id: manifest.name, title: manifest.title ?? manifest.name, version: manifest.version,
      sourceKind: 'bundled', source: path.dirname(file!), fsPath: path.dirname(file!), trust: 'bundled',
      capabilitiesGranted: ['prompt:inject'], manifest, installedAt: 0, updatedAt: 0,
    };
    const seed = examplePresetSeedPrompt(record, 'en', () => record.title).text;
    const prompt = composeTemplatePrompt(seed, user);
    const envelope = prompt.match(/^<readable-template-reference role="([^"]+)">\n(.*?)\n<\/readable-template-reference>/s)!;
    expect(envelope[1]).toBe('structure-and-visual-style-only');
    expect(JSON.parse(envelope[2]!)).toEqual({ source: 'selected-template', exampleWorkflow: 'omitted' });
    expect(prompt.endsWith(`<readable-user-content-source/>\n\n${user}`)).toBe(true);
    const gate = prompt.match(/<readable-template-content-gate>(.*?)<\/readable-template-content-gate>/s)!;
    expect(JSON.parse(gate[1]!)).toEqual({
      version: 1, source: 'user-content-only',
      askWhen: ['no-substantive-content', 'explicitly-requested-content-missing'],
      optionalFields: 'omit', otherwise: 'generate', output: 'index.html',
      factFidelity: { factSources: ['user-request', 'user-attachments'], outsideFacts: 'forbidden', suppliedFacts: 'preserve-all-verbatim', unsuppliedFields: 'omit' },
    });
    expect(prompt.indexOf(gate[0])).toBeGreaterThan(prompt.indexOf('</readable-template-reference>'));
    expect(prompt.indexOf(gate[0])).toBeLessThan(prompt.indexOf('<readable-user-content-source/>'));
    const ref = { id: record.id, name: record.title, boundary: templatePromptBoundary(seed, user) };
    expect(userTextFromTemplateMessage(prompt, ref)).toBe(user);
    expect(ref.boundary).toBeGreaterThan(prompt.indexOf('</readable-template-reference>'));
    expect(prompt.slice(ref.boundary)).toBe(user);
  });
});
