import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, type ComposeInput } from '../src/prompts/system.js';
import { renderHtmlOutputDirective, HTML_OUTPUT_POLICY } from '../src/prompts/html-output-policy.js';

const surfaces: ComposeInput[] = [
  {},
  ...(['other', 'prototype', 'template', 'deck'] as const).map(kind => ({ metadata: { kind } })),
  ...(['prototype', 'template', 'design-system', 'deck'] as const).flatMap(skillMode => [
    { skillMode }, { skillMode, skillBody: 'Read assets/template.html; write topic.html.' },
  ]),
  { metadata: { kind: 'prototype', platformTargets: ['mobile-ios', 'mobile-android'], includeLandingPage: true } },
  { metadata: { kind: 'template' }, template: { id: 'topic', createdAt: 1, name: 'Topic', files: [{ name: 'topic.html', content: '<html></html>' }] } },
];
const cases = surfaces.flatMap((surface, surfaceId) =>
  [undefined, 'plain'].flatMap(streamFormat =>
    [undefined, 'chat' as const].flatMap(sessionMode =>
      [{}, { skipDiscoveryBrief: true }, { examplePrompt: true, skipDiscoveryBrief: true }].map((mode, modeId) => ({
        name: `${surfaceId}/${streamFormat ?? 'tools'}/${sessionMode ?? 'design'}/${modeId}`,
        input: { ...surface, streamFormat, sessionMode, metadata: modeId === 0 ? surface.metadata : { kind: 'other' as const, ...surface.metadata, ...mode } },
      })))));

describe('single HTML composition policy', () => {
  it.each(cases)('$name', ({ input }) => {
    const prompt = composeSystemPrompt({
      ...input,
      pluginBlock: 'PLUGIN_SENTINEL: write plugin.html',
      activeStageBlocks: ['STAGE_SENTINEL: write stage.html'],
      designSystemBody: 'DESIGN_SENTINEL: write brand.html',
    });
    const policies = [...prompt.matchAll(/<readable-html-output-policy>([^<]+)<\/readable-html-output-policy>/g)];
    expect(policies).toHaveLength(1);
    expect(JSON.parse(policies[0]![1]!)).toEqual({
      version: 1, entryFile: 'index.html', artifactIdentifier: 'index', editMode: 'in-place',
      additionalHtml: 'explicit-user-approval', fileBackedHandoff: 'summary-only',
      fileTools: input.streamFormat !== 'plain', delivery: input.streamFormat === 'plain' ? 'artifact' : 'file',
    });
    expect(JSON.parse(policies[0]![1]!)).toMatchObject(HTML_OUTPUT_POLICY);
    expect(prompt).toContain(renderHtmlOutputDirective(input.streamFormat));
    for (const sentinel of ['PLUGIN_SENTINEL', 'STAGE_SENTINEL', 'DESIGN_SENTINEL']) {
      expect(policies[0]!.index).toBeLessThan(prompt.indexOf(sentinel));
    }
    const htmlHandoffs = [...prompt.matchAll(/<artifact\s+identifier="([^"]+)"\s+type="text\/html"/g)];
    expect(htmlHandoffs.map(match => match[1])).toEqual(input.streamFormat === 'plain' ? ['index'] : []);
  });

  it('ships the entire policy module byte-identically in daemon and contracts', () => {
    const local = readFileSync(new URL('../src/prompts/html-output-policy.ts', import.meta.url));
    const daemon = readFileSync(new URL('../../../apps/daemon/src/prompts/html-output-policy.ts', import.meta.url));
    expect(local.equals(daemon)).toBe(true);
  });
});
