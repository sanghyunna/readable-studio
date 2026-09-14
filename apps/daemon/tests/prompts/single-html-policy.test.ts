import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, type ComposeInput } from '../../src/prompts/system.js';
import { renderHtmlOutputDirective } from '../../src/prompts/html-output-policy.js';

const surfaces: ComposeInput[] = [
  {}, { metadata: {} },
  ...['other', 'prototype', 'template', 'design-system', 'deck'].map(kind => ({ metadata: { kind } })),
  ...(['prototype', 'template', 'design-system', 'deck'] as const).flatMap(skillMode => [
    { skillMode }, { skillMode, skillBody: 'Read assets/template.html; write topic.html.' },
  ]),
  { skillModes: ['prototype', 'deck'] },
  { skillModes: ['deck'], skillBody: 'Read assets/template.html.' },
  { metadata: { kind: 'prototype', platformTargets: ['ios', 'android'], includeLandingPage: true } },
  { metadata: { kind: 'template' }, template: { name: 'Topic', files: [{ name: 'topic.html', content: '<html></html>' }] } },
  { editablePromptBodies: { 'designer-charter': 'CHARTER_SENTINEL', 'discovery-workflow': 'DISCOVERY_SENTINEL', 'deck-framework': 'DECK_SENTINEL' }, metadata: { kind: 'deck' } },
];
const cases = surfaces.flatMap((surface, surfaceId) =>
  [undefined, 'plain'].flatMap(streamFormat =>
    [undefined, 'chat' as const].flatMap(sessionMode =>
      [{}, { skipDiscoveryBrief: true }, { examplePrompt: true, skipDiscoveryBrief: true }].map((mode, modeId) => ({
        name: `${surfaceId}/${streamFormat ?? 'tools'}/${sessionMode ?? 'design'}/${modeId}`,
        input: { ...surface, streamFormat, sessionMode, metadata: modeId === 0 ? surface.metadata : { ...surface.metadata, ...mode } },
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
    expect(prompt).toContain(renderHtmlOutputDirective(input.streamFormat));
    for (const sentinel of ['PLUGIN_SENTINEL', 'STAGE_SENTINEL', 'DESIGN_SENTINEL']) {
      expect(policies[0]!.index).toBeLessThan(prompt.indexOf(sentinel));
    }
    for (const sentinel of Object.values(input.editablePromptBodies ?? {})) {
      expect(policies[0]!.index).toBeLessThan(prompt.indexOf(sentinel));
    }
    const htmlHandoffs = [...prompt.matchAll(/<artifact\s+identifier="([^"]+)"\s+type="text\/html"/g)];
    expect(htmlHandoffs.map(match => match[1])).toEqual(input.streamFormat === 'plain' ? ['index'] : []);
  });
});
