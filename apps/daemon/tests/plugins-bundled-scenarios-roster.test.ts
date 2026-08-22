// Plan §3.N4 / spec §23.3.3 — bundled scenario plugins roster.
//
// Each `taskKind` enum value (new-generation / code-migration /
// figma-migration / tune-collab) maps to exactly one *canonical* bundled
// `readable.kind: 'scenario'` plugin under `plugins/_official/scenarios/`.
// The daemon's bundled boot walker registers all sibling scenarios; the
// canonical winner per taskKind is selected by `collectBundledScenarios`
// using the `readable-<taskKind>` id rule, so documented sibling scenarios can
// ride along without hijacking the pipeline-fallback.

import path from 'node:path';
import url from 'node:url';
import { readFile, readdir, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const scenariosRoot = path.join(repoRoot, 'plugins', '_official', 'scenarios');

const CANONICAL = new Map<string, { taskKind: string; pipelineStages: string[] }>([
  ['readable-new-generation',  { taskKind: 'new-generation',  pipelineStages: ['discovery', 'plan', 'generate', 'critique'] }],
  ['readable-figma-migration', { taskKind: 'figma-migration', pipelineStages: ['extract', 'tokens', 'generate', 'critique'] }],
  ['readable-code-migration',  { taskKind: 'code-migration',  pipelineStages: ['import', 'tokens', 'plan', 'verify', 'review', 'handoff'] }],
  ['readable-tune-collab',     { taskKind: 'tune-collab',     pipelineStages: ['direction', 'patch', 'critique', 'handoff'] }],
]);

// Non-canonical scenarios. These ride on a canonical taskKind but
// don't win the pipeline-fallback for it. They are user-facing plugins
// or export starters, but they must not become the canonical fallback.
const SIBLINGS = new Map<string, { taskKind: string }>([
  ['readable-default',          { taskKind: 'new-generation' }],
  ['readable-plugin-authoring', { taskKind: 'new-generation' }],
  ['readable-share-to-community', { taskKind: 'new-generation' }],
  ['readable-design-refine',    { taskKind: 'tune-collab' }],
  ['readable-react-export',     { taskKind: 'tune-collab' }],
  ['readable-nextjs-export',    { taskKind: 'tune-collab' }],
  ['readable-vue-export',       { taskKind: 'tune-collab' }],
]);

describe('plugins/_official/scenarios roster', () => {
  it('contains every canonical scenario folder (plus the documented siblings)', async () => {
    const entries = await readdir(scenariosRoot, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const expected = [...CANONICAL.keys(), ...SIBLINGS.keys()].sort();
    expect(dirs).toEqual(expected);
  });

  for (const [folder, expected] of CANONICAL) {
    it(`${folder} declares readable.kind='scenario' + the canonical pipeline shape`, async () => {
      const manifestPath = path.join(scenariosRoot, folder, 'readable-studio.json');
      const skillPath = path.join(scenariosRoot, folder, 'SKILL.md');
      expect((await stat(manifestPath)).isFile()).toBe(true);
      expect((await stat(skillPath)).isFile()).toBe(true);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest.name).toBe(folder);
      expect(manifest.readable.kind).toBe('scenario');
      expect(manifest.readable.taskKind).toBe(expected.taskKind);
      const stageIds = manifest.readable.pipeline.stages.map((s: { id: string }) => s.id);
      expect(stageIds).toEqual(expected.pipelineStages);
    });
  }

  for (const [folder, expected] of SIBLINGS) {
    it(`${folder} declares readable.kind='scenario' + a non-empty pipeline + the documented taskKind`, async () => {
      const manifestPath = path.join(scenariosRoot, folder, 'readable-studio.json');
      const skillPath = path.join(scenariosRoot, folder, 'SKILL.md');
      expect((await stat(manifestPath)).isFile()).toBe(true);
      expect((await stat(skillPath)).isFile()).toBe(true);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest.name).toBe(folder);
      expect(manifest.readable.kind).toBe('scenario');
      expect(manifest.readable.taskKind).toBe(expected.taskKind);
      expect(Array.isArray(manifest.readable.pipeline?.stages)).toBe(true);
      expect(manifest.readable.pipeline.stages.length).toBeGreaterThan(0);
      // Sibling scenarios MUST NOT use the canonical id, otherwise the
      // pipeline-fallback dedupe rule (`id === readable-<taskKind>`) would
      // mis-select the sibling as the canonical winner.
      expect(folder).not.toBe(`readable-${expected.taskKind}`);
    });
  }

  it('readable-default is hidden and asks for task type through a GenUI surface', async () => {
    const manifestPath = path.join(scenariosRoot, 'readable-default', 'readable-studio.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.readable.hidden).toBe(true);
    expect(manifest.readable.context?.craft).toEqual(
      expect.arrayContaining(['typography', 'color', 'anti-ai-slop']),
    );
    expect(manifest.readable.pipeline.stages[0].id).toBe('task-type');
    expect(manifest.readable.genui.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task-type',
          kind: 'choice',
          trigger: expect.objectContaining({ stageId: 'task-type' }),
        }),
      ]),
    );
  });

  it('readable-new-generation declares the default craft rails for anti-slop HTML output', async () => {
    const manifestPath = path.join(scenariosRoot, 'readable-new-generation', 'readable-studio.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.readable.context?.craft).toEqual(
      expect.arrayContaining(['typography', 'color', 'anti-ai-slop']),
    );
  });
});
