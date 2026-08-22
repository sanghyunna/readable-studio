import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_MANIFEST_RELATIVE_PATH,
  readProjectManifest,
  writeProjectManifest,
} from '../src/project-locations.js';

const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'readable-project-manifest-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project location manifests', () => {
  it('round-trips the Readable Studio project fixture with forward-compatible fields', async () => {
    // Given
    const projectDir = await temporaryProject();
    const manifest = {
      schemaVersion: 1 as const,
      id: 'sample-project',
      name: 'Sample project',
      createdAt: 1,
      updatedAt: 2,
      futureProjectField: { enabled: true },
    };

    // When
    await writeProjectManifest(projectDir, manifest);
    const parsed = await readProjectManifest(projectDir);

    // Then
    expect(PROJECT_MANIFEST_RELATIVE_PATH).toBe(path.join('.readable-studio', 'project.json'));
    expect(parsed).toMatchObject(manifest);
  });

  it('rejects an Readable Studio v1 project fixture with the documented unsupported code', async () => {
    // Given
    const projectDir = await temporaryProject();
    const retiredDataDirName = ['.', 'od'].join('');
    const legacyDir = path.join(projectDir, retiredDataDirName);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'legacy-project',
      name: 'Legacy project',
      createdAt: 1,
      updatedAt: 1,
    }));

    // When / Then
    await expect(readProjectManifest(projectDir)).rejects.toMatchObject({
      code: 'UNSUPPORTED_LEGACY_PRODUCT_V1',
    });
  });
});
