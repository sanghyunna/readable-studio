// Phase 4 / spec §14.1 — `readable plugin publish` URL builder unit test.
//
// The PR-template launcher is purely string assembly; we lock the
// public contract here so a future spec patch that retargets a
// catalog (e.g. anthropics/skills moves to a /pulls path or grows a
// dedicated submission form) updates this fixture in the same PR.

import { describe, expect, it } from 'vitest';
import {
  buildPublishLink,
  PublishError,
  PUBLISH_TARGETS,
  upsertMarketplaceJsonEntry,
} from '../src/plugins/publish.js';

const META = {
  pluginId:          'readable-studio/sample-plugin',
  pluginVersion:     '1.0.0',
  pluginTitle:       'Sample Plugin',
  pluginDescription: 'A fixture for the publish flow.',
  repoUrl:           'https://github.com/readable-studio/sample-plugin',
};

describe('buildPublishLink', () => {
  it('exports the four canonical catalog targets', () => {
    expect(PUBLISH_TARGETS.sort()).toEqual([
      'anthropics-skills',
      'awesome-agent-skills',
      'clawhub',
      'readable-studio',
      'skills-sh',
    ].sort());
  });

  it('builds a github-issue URL for anthropics/skills with title + body', () => {
    const link = buildPublishLink({ catalog: 'anthropics-skills', meta: META });
    expect(link.catalog).toBe('anthropics-skills');
    expect(link.catalogLabel).toBe('anthropics/skills');
    expect(link.url).toMatch(/^https:\/\/github\.com\/anthropics\/skills\/issues\/new\?/);
    const params = new URLSearchParams(link.url.split('?')[1]);
    expect(params.get('title')).toBe('Add Sample Plugin');
    expect(params.get('body')).toContain('A fixture for the publish flow.');
    expect(link.prBody).toContain('https://github.com/readable-studio/sample-plugin');
  });

  it('builds a github-issue URL for awesome-agent-skills', () => {
    const link = buildPublishLink({ catalog: 'awesome-agent-skills', meta: META });
    expect(link.url).toMatch(/^https:\/\/github\.com\/VoltAgent\/awesome-agent-skills\/issues\/new\?/);
  });

  it('builds a github-issue URL for clawhub', () => {
    const link = buildPublishLink({ catalog: 'clawhub', meta: META });
    expect(link.url).toMatch(/^https:\/\/github\.com\/openclaw\/clawhub\/issues\/new\?/);
  });

  it('points at skills.sh + the npx skills add command (no PR form there)', () => {
    const link = buildPublishLink({ catalog: 'skills-sh', meta: META });
    expect(link.url).toBe('https://skills.sh/');
    expect(link.prBody).toContain('npx skills add readable-studio/sample-plugin');
  });

  it('builds an Readable Studio registry submission URL', () => {
    // The dedicated `readable-studio/plugin-registry` repo per
    // docs/plans/plugin-registry.md §1.2 is the long-term target; until that
    // operational launch step happens, submissions land in `nexu-io/readable-studio`
    // (plugins/community/<plugin-name>/), keeping contribution where stars and
    // PR traffic already are.
    const link = buildPublishLink({ catalog: 'readable-studio', meta: META });
    expect(link.catalogLabel).toBe('sanghyunna/readable-studio');
    expect(link.url).toMatch(/^https:\/\/github\.com\/sanghyunna\/readable-studio\/issues\/new\?/);
    expect(link.prBody).toContain('plugins/community/<plugin-name>/readable-studio.json');
    expect(link.prBody).toContain('plugins/registry/community/readable-studio-marketplace.json');
  });

  it('falls back to owner/repo placeholder when repoUrl is missing for skills-sh', () => {
    const link = buildPublishLink({
      catalog: 'skills-sh',
      meta: { pluginId: 'sample-plugin', pluginVersion: '1.0.0' },
    });
    expect(link.prBody).toContain('npx skills add owner/repo');
  });

  it('rejects unknown catalogs', () => {
    expect(() => buildPublishLink({ catalog: 'mystery' as never, meta: META })).toThrow(PublishError);
  });
});

describe('upsertMarketplaceJsonEntry', () => {
  it('adds a namespaced plugin entry with a reproducible github source', () => {
    const outcome = upsertMarketplaceJsonEntry({
      generatedAt: '2026-05-14T00:00:00.000Z',
      manifest: {
        specVersion: '1.0.0',
        name: 'community',
        version: '0.1.0',
        plugins: [],
      },
      meta: META,
    });

    expect(outcome.inserted).toBe(true);
    expect(outcome.entry).toMatchObject({
      name: 'readable-studio/sample-plugin',
      source: 'github:readable-studio/sample-plugin',
      version: '1.0.0',
      title: 'Sample Plugin',
      publisher: {
        github: 'readable-studio',
      },
    });
    expect(outcome.manifest.plugins).toHaveLength(1);
    expect(outcome.manifest.generatedAt).toBe('2026-05-14T00:00:00.000Z');
  });

  it('updates existing entries and preserves unrelated catalog metadata', () => {
    const outcome = upsertMarketplaceJsonEntry({
      generatedAt: '2026-05-14T00:00:00.000Z',
      manifest: {
        specVersion: '1.0.0',
        name: 'community',
        version: '0.1.0',
        extra: true,
        plugins: [
          {
            name: 'readable-studio/sample-plugin',
            source: 'github:readable-studio/sample-plugin@old',
            version: '0.9.0',
            tags: ['kept'],
          },
        ],
      },
      meta: {
        ...META,
        pluginVersion: '1.1.0',
        repoUrl: 'https://github.com/readable-studio/sample-plugin/tree/main/plugins/sample',
      },
    });

    expect(outcome.inserted).toBe(false);
    expect(outcome.manifest.extra).toBe(true);
    expect(outcome.manifest.plugins[0]).toMatchObject({
      name: 'readable-studio/sample-plugin',
      source: 'github:readable-studio/sample-plugin@main/plugins/sample',
      version: '1.1.0',
      tags: ['kept'],
    });
  });

  it('rejects flat ids for public marketplace JSON', () => {
    expect(() => upsertMarketplaceJsonEntry({
      manifest: { plugins: [] },
      meta: {
        pluginId: 'sample-plugin',
        pluginVersion: '1.0.0',
        repoUrl: 'https://github.com/readable-studio/sample-plugin',
      },
    })).toThrow(PublishError);
  });
});
