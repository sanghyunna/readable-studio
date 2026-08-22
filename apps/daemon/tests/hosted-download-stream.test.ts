import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHostedDownloadStreams,
  HOSTED_DOWNLOAD_LIMITS,
  type HostedArchiveDownload,
} from '../src/hosted-download-stream.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

async function fixture(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-download-'));
  roots.push(root);
  await mkdir(path.join(root, 'project', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'project', 'index.html'), '<!doctype html>safe');
  await writeFile(path.join(root, 'project', 'nested', 'app.css'), 'body{}');
  return root;
}

function collect(download: HostedArchiveDownload): Promise<Buffer> {
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

describe('hosted archive download streaming', () => {
  it('streams only the selected root with safe attachment headers', async () => {
    const root = await fixture();
    const download = await createHostedDownloadStreams().openArchive({
      archiveName: '../café project.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'user-a',
    });

    expect(download.fileCount).toBe(2);
    expect(download.sourceBytes).toBe(25);
    expect(download.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(download.headers['Content-Disposition']).toMatch(/^attachment;/u);
    expect(download.headers['Content-Disposition']).not.toContain('..');
    expect(download.headers['Content-Disposition']).not.toContain(root);

    const zip = await JSZip.loadAsync(await collect(download));
    expect(Object.keys(zip.files).sort()).toEqual(['index.html', 'nested/', 'nested/app.css']);
    expect(await zip.file('nested/app.css')?.async('string')).toBe('body{}');
  });

  it('rejects traversal and link or junction escapes before returning a stream', async () => {
    const root = await fixture();
    const outside = mkdtempSync(path.join(tmpdir(), 'readable-hosted-download-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'project', 'escape'), 'junction');
    const downloads = createHostedDownloadStreams();

    await expect(downloads.openArchive({
      archiveName: 'bad.zip',
      relativeRoot: '../project',
      rootPath: root,
      userKey: 'user-a',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(downloads.openArchive({
      archiveName: 'bad.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'user-a',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('enforces the exact per-user source-byte ceiling without reading the file', async () => {
    const root = await fixture();
    const oversized = path.join(root, 'large.bin');
    await writeFile(oversized, '');
    await truncate(oversized, HOSTED_DOWNLOAD_LIMITS.bytesPerUser + 1);

    await expect(createHostedDownloadStreams().openArchive({
      archiveName: 'large.zip',
      rootPath: root,
      userKey: 'user-a',
    })).rejects.toMatchObject({ code: 'HOSTED_QUOTA_EXCEEDED' });
  });

  it('admits one stream per user and releases capacity on abort', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'project', 'random.bin'), randomBytes(1024 * 1024));
    const downloads = createHostedDownloadStreams();
    const first = await downloads.openArchive({
      archiveName: 'one.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'user-a',
    });

    await expect(downloads.openArchive({
      archiveName: 'two.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'user-a',
    })).rejects.toMatchObject({ code: 'HOSTED_OVERLOADED' });
    first.abort();

    const replacement = await downloads.openArchive({
      archiveName: 'replacement.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'user-a',
    });
    replacement.abort();
  });

  it('shares stream admission between archives and direct artifact downloads', async () => {
    const downloads = createHostedDownloadStreams();
    const artifact = downloads.openFile({
      bytes: 8,
      source: Readable.from('artifact'),
      userKey: 'user-a',
    });

    expect(() => downloads.openFile({
      bytes: 5,
      source: Readable.from('other'),
      userKey: 'user-a',
    })).toThrow(expect.objectContaining({ code: 'HOSTED_OVERLOADED' }));

    artifact.destroy();
    await new Promise<void>((resolve) => artifact.once('close', resolve));
    const replacement = downloads.openFile({
      bytes: 5,
      source: Readable.from('other'),
      userKey: 'user-a',
    });
    replacement.destroy();
  });

  it('caps process-wide concurrent streams and releases them on response close', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'project', 'random.bin'), randomBytes(1024 * 1024));
    const downloads = createHostedDownloadStreams();
    const active: HostedArchiveDownload[] = [];
    for (let index = 0; index < HOSTED_DOWNLOAD_LIMITS.streamsGlobal; index += 1) {
      active.push(await downloads.openArchive({
        archiveName: `${index}.zip`,
        relativeRoot: 'project',
        rootPath: root,
        userKey: `user-${index}`,
      }));
    }

    await expect(downloads.openArchive({
      archiveName: 'overflow.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'overflow',
    })).rejects.toMatchObject({ code: 'HOSTED_CAPACITY_EXHAUSTED' });

    const destination = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    active[0]!.pipeTo(destination);
    const closed = new Promise<void>((resolve) => destination.once('close', resolve));
    destination.destroy();
    await closed;

    const admitted = await downloads.openArchive({
      archiveName: 'admitted.zip',
      relativeRoot: 'project',
      rootPath: root,
      userKey: 'overflow',
    });
    admitted.abort();
    for (const download of active) download.abort();
  });

  it('pins the idle and total stream time bounds', () => {
    expect(HOSTED_DOWNLOAD_LIMITS.idleTimeoutMs).toBe(30_000);
    expect(HOSTED_DOWNLOAD_LIMITS.totalTimeoutMs).toBe(10 * 60_000);
  });
});
