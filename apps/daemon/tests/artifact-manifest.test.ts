import { describe, expect, it } from 'vitest';

import {
  inferLegacyManifest,
  parsePersistedManifest,
  validateArtifactManifestInput,
} from '../src/artifact-manifest.js';

function validBase() {
  return {
    schema: 'readable-studio.artifact-manifest.v1',
    kind: 'html',
    renderer: 'html',
    title: 'Test',
    exports: ['html'],
  };
}

describe('validateArtifactManifestInput', () => {
  it('rejects empty exports', () => {
    const res = validateArtifactManifestInput({ ...validBase(), exports: [] }, 'index.html');
    expect(res.ok).toBe(false);
  });

  it('rejects invalid kind and renderer and export', () => {
    expect(
      validateArtifactManifestInput(
        { ...validBase(), kind: 'evil-kind', renderer: 'html', exports: ['html'] },
        'index.html',
      ).ok,
    ).toBe(false);
    expect(
      validateArtifactManifestInput(
        { ...validBase(), kind: 'html', renderer: 'evil-renderer', exports: ['html'] },
        'index.html',
      ).ok,
    ).toBe(false);
    expect(
      validateArtifactManifestInput(
        { ...validBase(), kind: 'html', renderer: 'html', exports: ['exe'] },
        'index.html',
      ).ok,
    ).toBe(false);
  });

  it('rejects traversal in supportingFiles', () => {
    const res = validateArtifactManifestInput(
      { ...validBase(), supportingFiles: ['../secret.txt'] },
      'index.html',
    );
    expect(res.ok).toBe(false);
  });

  it('writes the Readable Studio artifact schema', () => {
    const res = validateArtifactManifestInput(validBase(), 'index.html');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value?.schema).toBe('readable-studio.artifact-manifest.v1');
      expect(res.value?.status).toBe('complete');
    }
  });

  it('rejects the old version shape at the machine boundary', () => {
    const result = validateArtifactManifestInput({
      ...validBase(),
      schema: undefined,
      version: 1,
    }, 'index.html');

    expect(result).toEqual({
      ok: false,
      error: 'artifactManifest.schema must be readable-studio.artifact-manifest.v1',
    });
  });

  it('rejects persisted manifests from the old schema', () => {
    const oldManifest = JSON.stringify({
      ...validBase(),
      schema: undefined,
      version: 1,
      entry: 'index.html',
    });

    expect(parsePersistedManifest(oldManifest, 'index.html')).toBeNull();
  });

  it('preserves valid status values', () => {
    const res = validateArtifactManifestInput({ ...validBase(), status: 'streaming' }, 'index.html');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.status).toBe('streaming');
  });

  it('preserves an existing updatedAt timestamp when requested', () => {
    const res = validateArtifactManifestInput(
      { ...validBase(), updatedAt: '2026-05-01T00:00:00.000Z' },
      'index.html',
      { preserveUpdatedAt: true },
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.updatedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('stamps updatedAt at validation time by default', () => {
    const res = validateArtifactManifestInput(
      { ...validBase(), updatedAt: '2026-05-01T00:00:00.000Z' },
      'index.html',
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value?.updatedAt).not.toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('inferLegacyManifest', () => {
  it('infers markdown manifest for .md files', () => {
    const out = inferLegacyManifest('README.md');
    expect(out?.kind).toBe('markdown-document');
    expect(out?.renderer).toBe('markdown');
    expect(out?.status).toBe('complete');
    expect(out?.exports).toEqual(['md', 'html', 'pdf', 'zip']);
  });

  it('infers svg manifest for .svg files', () => {
    const out = inferLegacyManifest('logo.svg');
    expect(out?.kind).toBe('svg');
    expect(out?.renderer).toBe('svg');
    expect(out?.status).toBe('complete');
    expect(out?.exports).toEqual(['svg', 'zip']);
  });
});
