import fs from 'node:fs';
import { mkdtemp, mkdir, readdir, rename, rm, symlink, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HOSTED_ARTIFACT_LIMITS,
  createHostedArtifactAdapter,
} from '../src/hosted-artifact-adapter.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('hosted artifact adapter', () => {
  it('saves and downloads through an opaque ID without exposing an absolute path', async () => {
    const { adapter, artifactsRoot } = await fixture();
    try {
      const response = adapter.save({
        identifier: 'hero',
        title: 'Hosted artifact',
        html: '<!doctype html><h1>Hello</h1>',
      });
      expect(response.artifactId).toMatch(/^oda_[A-Za-z0-9_-]{43}$/u);
      expect(response.url).toBe(`/api/artifacts/${response.artifactId}/download`);
      expect(Object.keys(response).sort()).toEqual(['artifactId', 'lint', 'url']);
      expect(JSON.stringify(response)).not.toContain(artifactsRoot);
      expect(JSON.stringify(response)).not.toContain(path.resolve(artifactsRoot));

      const download = adapter.openDownload(response.artifactId);
      expect(download).toMatchObject({
        artifactId: response.artifactId,
        contentType: 'text/html; charset=utf-8',
        fileName: 'artifact.html',
        size: Buffer.byteLength('<!doctype html><h1>Hello</h1>'),
      });
      expect(Object.keys(download).sort()).toEqual([
        'artifactId', 'contentType', 'fileName', 'size', 'stream',
      ]);
      expect(download.stream.path).toBeUndefined();
      expect(await streamText(download.stream)).toBe('<!doctype html><h1>Hello</h1>');
    } finally {
      adapter.dispose();
    }
  });

  it('reuses the existing lint output and accepts only the exact bounded DTOs', async () => {
    const { adapter, artifactsRoot } = await fixture();
    try {
      const lint = adapter.lint({ html: '<h1>Feature One</h1>' });
      expect(lint.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'filler-copy' }),
      ]));
      expect(lint.agentMessage).toEqual(expect.any(String));

      for (const request of [
        null,
        {},
        { html: '' },
        { html: '<h1>ok</h1>', owner: 'user-a' },
        { html: '<h1>ok</h1>', identifier: 'x'.repeat(257) },
      ]) expect(() => adapter.save(request)).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
      expect(await readdir(artifactsRoot)).toEqual([]);

      expect(() => adapter.lint({ html: 'x'.repeat(HOSTED_ARTIFACT_LIMITS.htmlBytes + 1) }))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_QUOTA_EXCEEDED' }));
      expect(() => adapter.save({ html: 'x'.repeat(HOSTED_ARTIFACT_LIMITS.htmlBytes + 1) }))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_QUOTA_EXCEEDED' }));
    } finally {
      adapter.dispose();
    }
  });

  it('accepts HTML exactly at the 3 MiB boundary', async () => {
    const { adapter } = await fixture();
    try {
      const response = adapter.save({ html: 'x'.repeat(HOSTED_ARTIFACT_LIMITS.htmlBytes) });
      const download = adapter.openDownload(response.artifactId);
      expect(download.size).toBe(HOSTED_ARTIFACT_LIMITS.htmlBytes);
      download.stream.destroy();
    } finally {
      adapter.dispose();
    }
  });

  it('rebuilds admission accounting across restart and leaves no partial artifact on rejection', async () => {
    const limits = { aggregateBytesPerUser: 1_024, artifactsPerUser: 2 };
    const { adapter, artifactsRoot } = await fixture('restart', limits);
    const first = adapter.save({ html: '<h1>first</h1>' });
    adapter.dispose();

    const restarted = createHostedArtifactAdapter({ artifactsRoot, admissionLimits: limits });
    try {
      expect(await streamText(restarted.openDownload(first.artifactId).stream)).toBe('<h1>first</h1>');
      restarted.save({ html: '<h1>second</h1>' });
      const before = await readdir(artifactsRoot);
      expect(() => restarted.save({ html: '<h1>rejected</h1>' }))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_QUOTA_EXCEEDED' }));
      expect(await readdir(artifactsRoot)).toEqual(before);
    } finally {
      restarted.dispose();
    }
  });

  it('enforces aggregate bytes from existing artifacts and scavenges incomplete saves', async () => {
    const limits = { aggregateBytesPerUser: 10, artifactsPerUser: 10 };
    const { adapter, artifactsRoot } = await fixture('aggregate', limits);
    adapter.save({ html: '123456' });
    adapter.dispose();
    const partialId = `oda_${'x'.repeat(43)}`;
    await mkdir(path.join(artifactsRoot, partialId));

    const restarted = createHostedArtifactAdapter({ artifactsRoot, admissionLimits: limits });
    try {
      expect(await readdir(artifactsRoot)).not.toContain(partialId);
      const before = await readdir(artifactsRoot);
      expect(() => restarted.save({ html: '12345' }))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_QUOTA_EXCEEDED' }));
      expect(await readdir(artifactsRoot)).toEqual(before);
    } finally {
      restarted.dispose();
    }
  });

  it('keeps copied artifact IDs inside their per-user adapter root', async () => {
    const a = await fixture('user-a');
    const b = await fixture('user-b');
    try {
      const saved = a.adapter.save({ html: '<h1>A private</h1>' });
      expect(() => b.adapter.openDownload(saved.artifactId))
        .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(JSON.stringify(saved)).not.toContain(a.artifactsRoot);
      expect(JSON.stringify(saved)).not.toContain(b.artifactsRoot);
    } finally {
      a.adapter.dispose();
      b.adapter.dispose();
    }
  });

  it('rejects an indexed output that grows beyond 100 MiB', async () => {
    const { adapter, artifactsRoot } = await fixture();
    try {
      const saved = adapter.save({ html: '<h1>small</h1>' });
      await truncate(
        path.join(artifactsRoot, saved.artifactId, 'index.html'),
        HOSTED_ARTIFACT_LIMITS.outputBytes + 1,
      );
      expect(() => adapter.openDownload(saved.artifactId))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_QUOTA_EXCEEDED' }));
    } finally {
      adapter.dispose();
    }
  });

  it('rejects reparse-point replacement and disposed indexes fail closed', async () => {
    const { adapter, artifactsRoot } = await fixture();
    const saved = adapter.save({ html: '<h1>safe</h1>' });
    const indexedDirectory = path.join(artifactsRoot, saved.artifactId);
    const movedDirectory = path.join(artifactsRoot, 'moved-artifact');
    await rename(indexedDirectory, movedDirectory);
    await symlink(
      movedDirectory,
      indexedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => adapter.openDownload(saved.artifactId))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    adapter.dispose();
    adapter.dispose();
    expect(() => adapter.openDownload(saved.artifactId))
      .toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
    expect(() => adapter.save({ html: '<h1>late</h1>' }))
      .toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('rejects a reparse-point artifacts root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'readable-hosted-artifact-link-'));
    roots.push(root);
    const realRoot = path.join(root, 'real');
    const linkedRoot = path.join(root, 'linked');
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => createHostedArtifactAdapter({ artifactsRoot: linkedRoot }))
      .toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});

async function fixture(
  name = 'artifacts',
  admissionLimits?: Parameters<typeof createHostedArtifactAdapter>[0]['admissionLimits'],
): Promise<{
  adapter: ReturnType<typeof createHostedArtifactAdapter>;
  artifactsRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `readable-hosted-${name}-`));
  roots.push(root);
  const artifactsRoot = path.join(root, 'artifacts');
  await mkdir(artifactsRoot);
  return {
    adapter: createHostedArtifactAdapter({
      artifactsRoot,
      ...(admissionLimits === undefined ? {} : { admissionLimits }),
    }),
    artifactsRoot: fs.realpathSync(artifactsRoot),
  };
}

async function streamText(stream: fs.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
