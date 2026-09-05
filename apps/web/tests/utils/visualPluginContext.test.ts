import {
  PluginManifestSchema,
  composeSystemPrompt,
  type InstalledPluginRecord,
} from '@readable-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  pluginsWithVisualReferences,
  visualReferenceForPlugin,
} from '../../src/utils/visualPluginContext';

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { eager: true; import: 'default' },
    ): Record<string, unknown>;
  }
}

const bundledManifestModules = import.meta.glob(
  '../../../../plugins/_official/**/readable-studio.json',
  { eager: true, import: 'default' },
);

const PRESENTATION_TERMS = new Set([
  'app', 'article', 'bold', 'card', 'cinematic', 'clean', 'content', 'dashboard',
  'dark', 'deck', 'design', 'editorial', 'example', 'frame', 'glass', 'grid',
  'html', 'landing', 'light', 'magazine', 'minimal', 'mobile', 'modern', 'page',
  'portfolio', 'poster', 'ppt', 'presentation', 'prototype', 'report', 'simple',
  'slide', 'slides', 'style', 'system', 'template', 'visual', 'web',
]);
const SUBJECT_NOUNS = new Set([
  'aerospace', 'agency', 'agriculture', 'automotive', 'banking', 'botanical',
  'clinical', 'cloud', 'coding', 'commerce', 'company', 'crypto', 'customer',
  'dataset', 'dating', 'developer', 'education', 'electronics', 'farming',
  'finance', 'financial', 'fintech', 'fragrance', 'gaming', 'healthcare',
  'insurance', 'invoice', 'investment', 'jet', 'marketing', 'medical', 'music',
  'nft', 'patient', 'payment', 'pet', 'product', 'property', 'research', 'resume',
  'school', 'software', 'student', 'trading', 'travel', 'valuation', 'vehicle',
]);

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function sourceLeakage(record: InstalledPluginRecord): string[] {
  const characteristics = record.manifest.readable?.visualReference?.characteristics ?? [];
  const contractWords = new Set(words(characteristics.join(' ')));
  const identityWords = words(`${record.id} ${record.title}`)
    .filter((word) => word.length >= 4 && !PRESENTATION_TERMS.has(word));
  const catalogueSubjectWords = [...SUBJECT_NOUNS]
    .filter((word) => contractWords.has(word));

  return [...new Set([...identityWords, ...catalogueSubjectWords])]
    .filter((word) => contractWords.has(word))
    .sort();
}

function recordFor(path: string, rawManifest: unknown): InstalledPluginRecord {
  const manifest = PluginManifestSchema.parse(rawManifest);
  return {
    id: manifest.name,
    title: manifest.title ?? manifest.name,
    version: manifest.version,
    sourceKind: 'bundled',
    source: path,
    trust: 'bundled',
    capabilitiesGranted: manifest.readable?.capabilities ?? [],
    manifest,
    fsPath: path,
    installedAt: 0,
    updatedAt: 0,
  };
}

describe('bundled additive visual plugin context', () => {
  it('exposes exactly the three bundled plugins with usable visual contracts', () => {
    const eligibleIds = pluginsWithVisualReferences(
      Object.entries(bundledManifestModules)
        .map(([path, manifest]) => recordFor(path, manifest))
        .filter((record) => record.manifest.readable?.kind !== 'atom'),
    ).map((record) => record.id).sort();

    expect(eligibleIds).toEqual([
      'design-system-apple',
      'example-acreage-farming',
      'example-innovation',
    ]);
  });

  it('never forwards catalogue descriptions through the @ context prompt path', () => {
    const records = Object.entries(bundledManifestModules)
      .map(([path, manifest]) => recordFor(path, manifest))
      .filter((record) => record.manifest.readable?.kind !== 'atom');

    expect(records.length).toBeGreaterThan(250);
    for (const record of records) {
      const reference = visualReferenceForPlugin(record);
      const prompt = composeSystemPrompt({
        metadata: {
          kind: 'other',
          visualReferences: reference ? [reference] : [],
        },
      });
      const description = record.manifest.description?.trim();

      expect(prompt, record.id).not.toContain('### @ plugin context');
      if (description) expect(prompt, record.id).not.toContain(description);
    }
  });

  it('uses the submit conversion itself to determine picker eligibility', () => {
    const eligibleManifest = PluginManifestSchema.parse({
      name: 'eligible-reference',
      title: 'Eligible Reference',
      version: '1.0.0',
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        visualReference: { characteristics: ['  layered editorial grid  '] },
      },
    });
    const emptyManifest = PluginManifestSchema.parse({
      name: 'empty-reference',
      title: 'Empty Reference',
      version: '1.0.0',
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        visualReference: { characteristics: ['   '] },
      },
    });
    const eligible = recordFor('eligible-fixture', eligibleManifest);
    const empty = recordFor('empty-fixture', emptyManifest);

    expect(visualReferenceForPlugin(eligible)).toEqual({
      characteristics: ['layered editorial grid'],
    });
    expect(visualReferenceForPlugin(empty)).toBeNull();
    expect(pluginsWithVisualReferences([eligible, empty])).toEqual([eligible]);
  });

  it('fails closed when a selectable plugin has no visual contract', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'subject-bearing-example',
      title: 'Source Identity',
      version: '1.0.0',
      description: 'A catalogue description about an unrelated subject.',
      readable: { kind: 'scenario', taskKind: 'new-generation' },
    });
    const record = recordFor('fixture', manifest);

    expect(visualReferenceForPlugin(record)).toBeNull();
    const prompt = composeSystemPrompt({ metadata: { kind: 'other', visualReferences: [] } });
    expect(prompt).not.toContain(manifest.description);
  });

  it('rejects source identity and catalogue subject nouns in every bundled contract', () => {
    const contractedRecords = Object.entries(bundledManifestModules)
      .map(([path, manifest]) => recordFor(path, manifest))
      .filter((record) => record.manifest.readable?.visualReference);

    expect(contractedRecords.length).toBeGreaterThan(0);
    for (const record of contractedRecords) {
      expect(sourceLeakage(record), record.id).toEqual([]);
    }
  });

  it('detects a planted subject-bearing contract', () => {
    const manifest = PluginManifestSchema.parse({
      name: 'example-source-identity',
      title: 'Source Identity',
      version: '1.0.0',
      description: 'A customer dataset shown as a visual example.',
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        visualReference: {
          characteristics: ['Recreate the Source Identity customer dataset in bordered cards.'],
        },
      },
    });

    expect(sourceLeakage(recordFor('fixture', manifest))).toEqual([
      'customer',
      'dataset',
      'identity',
      'source',
    ]);
  });
});
