import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginHostedUploadIntake,
  HOSTED_UPLOAD_LIMITS,
  type HostedMultipartFileDescriptor,
} from '../src/hosted-upload-adapter.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

async function fixture(): Promise<{ destinationRoot: string; uploadsRoot: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'readable-hosted-upload-'));
  roots.push(root);
  const uploadsRoot = path.join(root, 'uploads');
  const destinationRoot = path.join(root, 'project');
  await mkdir(uploadsRoot);
  await mkdir(destinationRoot);
  return { destinationRoot, uploadsRoot };
}

async function stagedFile(
  stagingRoot: string,
  name: string,
  content: string | Buffer,
): Promise<HostedMultipartFileDescriptor> {
  const stagedPath = path.join(stagingRoot, `part-${name.replace(/[^a-z0-9]/giu, '-')}`);
  await writeFile(stagedPath, content);
  return {
    fieldname: 'files',
    mimetype: 'application/octet-stream',
    originalname: name,
    path: stagedPath,
    size: Buffer.byteLength(content),
  };
}

const lane = async <T>(commit: () => Promise<T>): Promise<T> => commit();

describe('hosted upload intake', () => {
  it('promotes bounded multipart files inside the lane and returns only relative names', async () => {
    const { destinationRoot, uploadsRoot } = await fixture();
    const intake = await beginHostedUploadIntake({ uploadsRoot });
    const files = [
      await stagedFile(intake.stagingRoot, 'hello.txt', 'hello'),
      await stagedFile(intake.stagingRoot, '디자인.png', Buffer.from([1, 2, 3])),
    ];
    let laneEntered = false;
    const result = await intake.finalize({
      commitInLane: async (commit) => {
        laneEntered = true;
        return commit();
      },
      destinationRoot,
      fields: { dir: 'assets/images' },
      files,
    });

    expect(laneEntered).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.name.startsWith('assets/images/'))).toBe(true);
    expect(result.files.every((file) => !path.isAbsolute(file.name))).toBe(true);
    expect(result.files.map((file) => file.originalName)).toEqual(['hello.txt', '디자인.png']);
    expect(readFileSync(path.join(destinationRoot, result.files[0]!.name), 'utf8')).toBe('hello');
    expect(existsSync(intake.stagingRoot)).toBe(false);
  });

  it('rejects file-count, per-file, and total request limits and cleans staging', async () => {
    const { destinationRoot, uploadsRoot } = await fixture();

    const empty = await beginHostedUploadIntake({ uploadsRoot });
    await expect(empty.finalize({
      commitInLane: lane,
      destinationRoot,
      fields: {},
      files: [],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(existsSync(empty.stagingRoot)).toBe(false);

    const oversized = await beginHostedUploadIntake({ uploadsRoot });
    const largePath = path.join(oversized.stagingRoot, 'large');
    await writeFile(largePath, '');
    await truncate(largePath, HOSTED_UPLOAD_LIMITS.fileBytes + 1);
    await expect(oversized.finalize({
      commitInLane: lane,
      destinationRoot,
      fields: {},
      files: [{
        fieldname: 'files',
        mimetype: 'application/octet-stream',
        originalname: 'large.bin',
        path: largePath,
        size: HOSTED_UPLOAD_LIMITS.fileBytes + 1,
      }],
    })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(existsSync(oversized.stagingRoot)).toBe(false);

    const tooMany = await beginHostedUploadIntake({ uploadsRoot });
    const files: HostedMultipartFileDescriptor[] = [];
    for (let index = 0; index <= HOSTED_UPLOAD_LIMITS.files; index += 1) {
      files.push(await stagedFile(tooMany.stagingRoot, `${index}.txt`, 'x'));
    }
    await expect(tooMany.finalize({
      commitInLane: lane,
      destinationRoot,
      fields: {},
      files,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(existsSync(tooMany.stagingRoot)).toBe(false);

    const request = await beginHostedUploadIntake({ uploadsRoot });
    const requestFiles: HostedMultipartFileDescriptor[] = [];
    for (let index = 0; index < 6; index += 1) {
      const file = path.join(request.stagingRoot, `request-${index}`);
      await writeFile(file, '');
      await truncate(file, 17 * 1024 * 1024);
      requestFiles.push({
        fieldname: 'files',
        mimetype: 'application/octet-stream',
        originalname: `${index}.bin`,
        path: file,
        size: 17 * 1024 * 1024,
      });
    }
    await expect(request.finalize({
      commitInLane: lane,
      destinationRoot,
      fields: {},
      files: requestFiles,
    })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(existsSync(request.stagingRoot)).toBe(false);
  });

  it('accepts only the optional canonical dir field', async () => {
    const { destinationRoot, uploadsRoot } = await fixture();
    for (const fields of [
      { dir: '../outside' },
      { dir: 'assets\\images' },
      { dir: 'assets//images' },
      { owner: 'user-a' },
    ]) {
      const intake = await beginHostedUploadIntake({ uploadsRoot });
      const file = await stagedFile(intake.stagingRoot, 'file.txt', 'safe');
      await expect(intake.finalize({
        commitInLane: lane,
        destinationRoot,
        fields,
        files: [file],
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(existsSync(intake.stagingRoot)).toBe(false);
    }
  });

  it('rejects a staged junction and an aliased destination root', async () => {
    const { destinationRoot, uploadsRoot } = await fixture();
    const outside = mkdtempSync(path.join(tmpdir(), 'readable-hosted-upload-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');

    const intake = await beginHostedUploadIntake({ uploadsRoot });
    const junction = path.join(intake.stagingRoot, 'junction');
    await symlink(outside, junction, 'junction');
    await expect(intake.finalize({
      commitInLane: lane,
      destinationRoot,
      fields: {},
      files: [{
        fieldname: 'files',
        mimetype: 'application/octet-stream',
        originalname: 'secret.txt',
        path: junction,
        size: 0,
      }],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');

    const aliased = path.join(path.dirname(destinationRoot), 'project-alias');
    await symlink(destinationRoot, aliased, 'junction');
    const aliasedIntake = await beginHostedUploadIntake({ uploadsRoot });
    const file = await stagedFile(aliasedIntake.stagingRoot, 'safe.txt', 'safe');
    await expect(aliasedIntake.finalize({
      commitInLane: lane,
      destinationRoot: aliased,
      fields: {},
      files: [file],
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(readdirSync(destinationRoot)).toEqual([]);
  });

  it('rolls back promoted files and directories when the lane rejects acknowledgement', async () => {
    const { destinationRoot, uploadsRoot } = await fixture();
    const intake = await beginHostedUploadIntake({ uploadsRoot });
    const file = await stagedFile(intake.stagingRoot, 'safe.txt', 'safe');

    await expect(intake.finalize({
      commitInLane: async (commit) => {
        await commit();
        throw new Error('snapshot acknowledgement failed');
      },
      destinationRoot,
      fields: { dir: 'new/nested' },
      files: [file],
    })).rejects.toThrow('snapshot acknowledgement failed');
    expect(readdirSync(destinationRoot)).toEqual([]);
    expect(existsSync(intake.stagingRoot)).toBe(false);
  });

  it('exposes the exact parser limits and idempotent abort cleanup', async () => {
    expect(HOSTED_UPLOAD_LIMITS).toMatchObject({
      dirBytes: 1_024,
      fileBytes: 20 * 1024 * 1024,
      files: 12,
      requestBytes: 100 * 1024 * 1024,
      timeoutMs: 120_000,
    });
    const { uploadsRoot } = await fixture();
    const intake = await beginHostedUploadIntake({ uploadsRoot });
    await intake.cleanup();
    await expect(intake.cleanup()).resolves.toBeUndefined();
    expect(existsSync(intake.stagingRoot)).toBe(false);
  });
});
