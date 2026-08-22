import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostedArtifactDownload } from '../src/hosted-artifact-adapter.js';
import type { HostedArchiveDownload } from '../src/hosted-download-stream.js';
import {
  createHostedRuntimeRegistry,
  dispatchHostedRuntimeInternalOperation,
  type HostedRuntimeLease,
  type HostedRuntimeUploadIntake,
} from '../src/hosted-runtime-registry.js';
import type {
  HostedMultipartFileDescriptor,
} from '../src/hosted-upload-adapter.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('hosted runtime content ownership', () => {
  it('serializes bounded content mutations and streams the owned project archive', async () => {
    const { lease, registry } = await fixture();
    const laneEntered = deferred();
    const releaseLane = deferred();
    try {
      await expect(dispatch(registry, lease, {
        kind: 'content:dispatch',
        request: {
          kind: 'file.write',
          projectId: 'project-a',
          body: {
            name: 'too-large.txt',
            content: 'x'.repeat(3 * 1024 * 1024 + 1),
            encoding: 'utf8',
          },
        },
      })).rejects.toMatchObject({ code: 'HOSTED_QUOTA_EXCEEDED' });

      const blocker = dispatch(registry, lease, {
        kind: 'run:mutate',
        scope: { kind: 'project', projectId: 'project-a' },
        execute: async () => {
          laneEntered.resolve();
          await releaseLane.promise;
        },
      });
      await laneEntered.promise;

      let writeFinished = false;
      const write = dispatch(registry, lease, {
        kind: 'content:dispatch',
        request: {
          kind: 'file.write',
          projectId: 'project-a',
          body: {
            name: 'nested/index.html',
            content: '<!doctype html><h1>Owned</h1>',
            encoding: 'utf8',
          },
        },
      }).then((value) => {
        writeFinished = true;
        return value;
      });
      await Promise.resolve();
      expect(writeFinished).toBe(false);

      releaseLane.resolve();
      await expect(Promise.all([blocker, write])).resolves.toEqual([
        undefined,
        expect.objectContaining({
          file: expect.objectContaining({ name: 'nested/index.html' }),
        }),
      ]);

      await expect(dispatch(registry, lease, {
        kind: 'content:dispatch',
        request: { kind: 'file.read', projectId: 'project-a', path: 'nested/index.html' },
      })).resolves.toMatchObject({
        content: Buffer.from('<!doctype html><h1>Owned</h1>'),
        file: { name: 'nested/index.html' },
      });

      const archive = await dispatch(registry, lease, {
        kind: 'archive:open',
        projectId: 'project-a',
        relativeRoot: 'nested',
      }) as HostedArchiveDownload;
      expect(archive.headers).toMatchObject({
        'Content-Type': 'application/zip',
        'X-Content-Type-Options': 'nosniff',
      });
      const zip = await JSZip.loadAsync(await collectArchive(archive));
      expect(await zip.file('index.html')?.async('string'))
        .toBe('<!doctype html><h1>Owned</h1>');
    } finally {
      releaseLane.resolve();
      lease.release();
      await registry.shutdown();
    }
  });

  it('promotes upload staging through the same user FIFO before content is visible', async () => {
    const { lease, registry } = await fixture();
    const laneEntered = deferred();
    const releaseLane = deferred();
    let intake: HostedRuntimeUploadIntake | null = null;
    try {
      intake = await dispatch(registry, lease, {
        kind: 'upload:begin',
        projectId: 'project-a',
      }) as HostedRuntimeUploadIntake;
      const stagedPath = path.join(intake.stagingRoot, 'part-1');
      await writeFile(stagedPath, 'uploaded');
      const files: HostedMultipartFileDescriptor[] = [{
        fieldname: 'files',
        mimetype: 'text/plain',
        originalname: 'upload.txt',
        path: stagedPath,
        size: Buffer.byteLength('uploaded'),
      }];

      const blocker = dispatch(registry, lease, {
        kind: 'run:mutate',
        scope: { kind: 'project', projectId: 'project-a' },
        execute: async () => {
          laneEntered.resolve();
          await releaseLane.promise;
        },
      });
      await laneEntered.promise;

      let finalized = false;
      const upload = intake.finalize({ fields: { dir: 'assets' }, files }).then((value) => {
        finalized = true;
        return value;
      });
      await Promise.resolve();
      expect(finalized).toBe(false);

      releaseLane.resolve();
      await blocker;
      const uploaded = await upload;
      expect(uploaded.files).toEqual([
        expect.objectContaining({ originalName: 'upload.txt' }),
      ]);
      const uploadedName = uploaded.files[0]!.name;
      await expect(dispatch(registry, lease, {
        kind: 'content:dispatch',
        request: { kind: 'file.read', projectId: 'project-a', path: uploadedName },
      })).resolves.toMatchObject({ content: Buffer.from('uploaded') });
      intake = null;
    } finally {
      releaseLane.resolve();
      await intake?.cleanup();
      lease.release();
      await registry.shutdown();
    }
  });

  it('restores saved artifacts across the lint, download, and eviction lifecycle', async () => {
    const runtimeRoot = runtimeFixture();
    const retired = deferred();
    const registry = createHostedRuntimeRegistry({
      idleEvictionMs: 25,
      runtimeRoot,
      onGenerationRetired: () => retired.resolve(),
    });
    const lease = registry.acquire({ userKey: 'user-a' });
    let download: HostedArtifactDownload | null = null;
    try {
      const saved = await dispatch(registry, lease, {
        kind: 'artifact:save',
        request: { html: '<!doctype html><h1>Private artifact</h1>' },
      }) as { artifactId: string };
      await expect(dispatch(registry, lease, {
        kind: 'artifact:lint',
        request: { html: '<h1>Feature One</h1>' },
      })).resolves.toMatchObject({ findings: expect.any(Array) });

      download = await dispatch(registry, lease, {
        kind: 'artifact:download',
        artifactId: saved.artifactId,
      }) as HostedArtifactDownload;
      expect(download.stream.path).toBeUndefined();
      await expect(streamText(download.stream))
        .resolves.toBe('<!doctype html><h1>Private artifact</h1>');
      download = null;

      const generation = lease.generation;
      lease.release();
      await retired.promise;

      const recreated = registry.acquire({ userKey: 'user-a' });
      try {
        expect(recreated.generation).toBeGreaterThan(generation);
        download = await dispatch(registry, recreated, {
          kind: 'artifact:download',
          artifactId: saved.artifactId,
        }) as HostedArtifactDownload;
        await expect(streamText(download.stream))
          .resolves.toBe('<!doctype html><h1>Private artifact</h1>');
        download = null;
      } finally {
        recreated.release();
      }
    } finally {
      download?.stream.destroy();
      lease.release();
      await registry.shutdown();
    }
  });
});

async function fixture() {
  const runtimeRoot = runtimeFixture();
  const registry = createHostedRuntimeRegistry({
    runtimeRoot,
    createEntityId: (kind) => kind === 'project' ? 'project-a' : `${kind}-a`,
  });
  const lease = registry.acquire({ userKey: 'user-a' });
  await expect(dispatch(registry, lease, {
    kind: 'metadata:mutate',
    operation: { kind: 'project.create', body: { title: 'Project A' } },
  })).resolves.toHaveProperty('project.id', 'project-a');
  return { lease, registry };
}

function runtimeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-runtime-content-'));
  roots.push(root);
  return root;
}

function dispatch(
  registry: ReturnType<typeof createHostedRuntimeRegistry>,
  lease: HostedRuntimeLease,
  operation: Parameters<typeof dispatchHostedRuntimeInternalOperation>[2],
): Promise<unknown> {
  return dispatchHostedRuntimeInternalOperation(registry, lease, operation);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function collectArchive(download: HostedArchiveDownload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    destination.once('finish', () => resolve(Buffer.concat(chunks)));
    destination.once('error', reject);
    download.pipeTo(destination);
  });
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
