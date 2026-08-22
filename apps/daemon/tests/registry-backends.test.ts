import { describe, expect, it } from 'vitest';
import type { MarketplaceManifest } from '@readable-studio/contracts';
import { StaticRegistryBackend } from '../src/registry/static-backend.js';

const manifest: MarketplaceManifest = {
  specVersion: '1.0.0',
  name: 'fixture',
  version: '1.0.0',
  plugins: [
    {
      name: 'vendor/example',
      title: 'Example',
      description: 'Searchable fixture plugin',
      version: '1.1.0',
      source: 'github:vendor/example@v1.1.0/plugin',
      versions: [
        {
          version: '1.0.0',
          source: 'github:vendor/example@v1.0.0/plugin',
          integrity: 'sha256:old',
        },
        {
          version: '1.1.0',
          source: 'github:vendor/example@v1.1.0/plugin',
          integrity: 'sha256:new',
        },
      ],
      distTags: { latest: '1.1.0' },
      license: 'MIT',
      capabilitiesSummary: ['prompt:inject'],
      tags: ['fixture'],
    },
  ],
};

describe('registry backends', () => {
  it('resolves exact versions and dist-tags from static manifests', async () => {
    const backend = new StaticRegistryBackend({
      id: 'fixture',
      trust: 'trusted',
      manifest,
    });

    await expect(backend.resolve('vendor/example')).resolves.toMatchObject({
      source: 'github:vendor/example@v1.1.0/plugin',
      integrity: 'sha256:new',
    });
    await expect(backend.resolve('vendor/example@1.0.0')).resolves.toMatchObject({
      source: 'github:vendor/example@v1.0.0/plugin',
      integrity: 'sha256:old',
    });
  });
});
